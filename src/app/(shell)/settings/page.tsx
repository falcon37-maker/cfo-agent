import { loadDashboardData } from "@/lib/pnl/queries";
import { fmtMoney } from "@/lib/format";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { StoresGrid } from "@/components/settings/StoresGrid";
import { CheckCircle2, AlertCircle } from "lucide-react";
import type { StoreCard } from "@/components/settings/StoresGrid";

export const dynamic = "force-dynamic";

const ERR_MAP: Record<string, string> = {
  invalid_code: "Code must be 2-16 chars, uppercase, A-Z + 0-9 + _.",
  missing_name: "Display name is required.",
  invalid_type: "Store type must be Shopify or Manual.",
  missing_domain: "Shopify stores need a shop domain.",
  missing_token_or_oauth:
    "Provide either an Admin API token (shpat_…) or a Client ID + Secret (shpss_…).",
  missing_enc_key: "CREDENTIAL_ENCRYPTION_KEY is not set on the server.",
  duplicate_id: "A store with that code already exists.",
  bad_fee_pct: "Processing fee % must be a number.",
  bad_fee_fixed: "Processing fee fixed must be a number.",
  forbidden: "You don't have permission to modify stores.",
};

type StoreRow = {
  id: string;
  name: string;
  shop_domain: string | null;
  shopify_domain: string | null;
  shopify_client_id: string | null;
  shopify_token_encrypted: string | null;
  shopify_client_secret_encrypted: string | null;
  processing_fee_pct: number | null;
  processing_fee_fixed: number | null;
  store_type: string | null;
  is_active: boolean;
  currency: string;
  timezone: string;
};

async function loadStoresForTenant(tenantId: string): Promise<StoreRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select(
      "id, name, shop_domain, shopify_domain, shopify_client_id, shopify_token_encrypted, shopify_client_secret_encrypted, processing_fee_pct, processing_fee_fixed, store_type, is_active, currency, timezone",
    )
    .eq("tenant_id", tenantId)
    .neq("id", "PORTFOLIO")
    .neq("id", "__BACKFILL_DEDUPE__")
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as StoreRow[];
}

export default async function StoresSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const params = await searchParams;
  const tenant = await requireTenant();
  const [data, stores] = await Promise.all([
    loadDashboardData(tenant.id),
    loadStoresForTenant(tenant.id),
  ]);
  const totalToday = data.storeMixToday.reduce((s, p) => s + p.revenue, 0);
  const statsByStore = new Map(data.storeMixToday.map((p) => [p.store, p]));

  const errKey = params.err ?? "";
  const errMessage = ERR_MAP[errKey] ?? (errKey ? errKey : null);

  // Build the props for the client component. We compute initial credential
  // source server-side so each card renders an accurate pill on first paint;
  // the client component then verifies live with /api/stores/test-connection
  // when the user clicks "Test connection" (or when the page first mounts —
  // see StoresGrid).
  const cards: StoreCard[] = stores.map((s) => {
    const mix = statsByStore.get(s.id);
    const today = mix?.revenue ?? 0;
    const share = totalToday > 0 ? (today / totalToday) * 100 : 0;
    // As of the env→DB migration (Jun 2026) we treat the database as the
    // single source of truth. Env-var fallback is no longer read at runtime
    // — see src/lib/shopify/stores.ts — so this flag is purely "does the
    // stores table row carry a token?". If yes → "db", else → "none".
    // The live `/api/stores/test-connection` ping then refines the badge
    // to Connected / Invalid based on the actual Shopify response.
    const dbHasToken =
      Boolean(s.shopify_token_encrypted) ||
      (Boolean(s.shopify_client_id) &&
        Boolean(s.shopify_client_secret_encrypted));
    const credSource: "db" | "env" | "none" = dbHasToken ? "db" : "none";
    return {
      id: s.id,
      name: s.name,
      domain: s.shopify_domain ?? s.shop_domain ?? null,
      store_type: (s.store_type ?? "shopify") as "shopify" | "manual",
      is_active: s.is_active,
      currency: s.currency,
      timezone: s.timezone,
      processing_fee_pct: s.processing_fee_pct,
      processing_fee_fixed: s.processing_fee_fixed,
      todayRevenue: today,
      sharePct: share,
      credSource,
      shopify_client_id: s.shopify_client_id,
      has_static_token: !!s.shopify_token_encrypted,
      has_oauth_secret: !!s.shopify_client_secret_encrypted,
    };
  });

  return (
    <>
      {params.ok ? (
        <div className="inline-banner banner-pos" style={{ marginBottom: 12 }}>
          <CheckCircle2 size={14} strokeWidth={2} />
          {decodeURIComponent(params.ok)}
        </div>
      ) : null}
      {errMessage ? (
        <div className="inline-banner banner-neg" style={{ marginBottom: 12 }}>
          <AlertCircle size={14} strokeWidth={2} />
          {errMessage}
        </div>
      ) : null}

      <StoresGrid cards={cards} />
    </>
  );
}

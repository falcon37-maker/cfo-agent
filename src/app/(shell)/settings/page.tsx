import { loadDashboardData } from "@/lib/pnl/queries";
import { fmtMoney } from "@/lib/format";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  AddStoreToggle,
  StoreEditRow,
  type StoreEditValues,
} from "@/components/settings/StoreForm";
import { CheckCircle2, AlertCircle } from "lucide-react";

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

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Stores</div>
            <div className="card-sub">
              {stores.length} configured · revenue share based on the most recent
              day with data
            </div>
          </div>
          <div className="card-actions">
            <AddStoreToggle />
          </div>
        </div>
        <div className="stores-grid">
          {stores.map((s) => {
            const mix = statsByStore.get(s.id);
            const today = mix?.revenue ?? 0;
            const share = totalToday > 0 ? (today / totalToday) * 100 : 0;
            const hasCreds =
              !!s.shopify_token_encrypted ||
              (!!s.shopify_client_id && !!s.shopify_client_secret_encrypted);
            const editValue: StoreEditValues = {
              id: s.id,
              name: s.name,
              store_type: (s.store_type ?? "shopify") as "shopify" | "manual",
              shopify_domain: s.shopify_domain ?? s.shop_domain,
              shopify_client_id: s.shopify_client_id,
              has_static_token: !!s.shopify_token_encrypted,
              has_oauth_secret: !!s.shopify_client_secret_encrypted,
              processing_fee_pct: s.processing_fee_pct,
              processing_fee_fixed: s.processing_fee_fixed,
              is_active: s.is_active,
            };
            return (
              <div key={s.id} className="store-card">
                <div className="store-head">
                  <div className="letter-tile">{s.id.charAt(0)}</div>
                  <span
                    className={`status-pill ${
                      !s.is_active ? "warn" : hasCreds ? "pos" : "warn"
                    }`}
                  >
                    <span className="dot" />
                    {!s.is_active
                      ? "Inactive"
                      : hasCreds
                        ? "Connected"
                        : "Needs token"}
                  </span>
                </div>
                <div className="store-name">{s.name}</div>
                <div className="store-url">
                  {s.shopify_domain ?? s.shop_domain}
                </div>
                <div className="store-divider" />
                <div className="store-meta">
                  <div>
                    <div className="sm-label">Today&apos;s revenue</div>
                    <div className="sm-val">{fmtMoney(today)}</div>
                  </div>
                  <div>
                    <div className="sm-label">Share</div>
                    <div className="sm-val" style={{ color: "var(--accent)" }}>
                      {share.toFixed(0)}%
                    </div>
                  </div>
                </div>
                <div className="store-acct">
                  {s.currency} · {s.timezone} · fees{" "}
                  {((s.processing_fee_pct ?? 0) * 100).toFixed(1)}%
                  {s.processing_fee_fixed != null && s.processing_fee_fixed > 0
                    ? ` + $${s.processing_fee_fixed.toFixed(2)}`
                    : ""}
                </div>
                <div style={{ marginTop: 10 }}>
                  <StoreEditRow value={editValue} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

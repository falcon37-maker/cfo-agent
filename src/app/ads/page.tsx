import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/auth/roles";
import { EntryShell } from "@/components/entry/EntryShell";
import { AdsForm } from "./AdsForm";
import type { StoreOption } from "@/components/entry/StoreSelect";
import { getCurrentTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

async function loadStores(tenantId: string): Promise<StoreOption[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select("id, name, shop_domain")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.shop_domain,
  }));
}

async function loadRecent(tenantId: string) {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("ad_spend_entries")
    .select("id, store_id, date, amount")
    .eq("tenant_id", tenantId)
    .order("submitted_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return (
    (data ?? []).map((r) => ({
      id: r.id,
      store_id: r.store_id,
      date: r.date,
      amount: Number(r.amount),
    })) ?? []
  );
}

export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  const role = getRole(user?.email);
  const tenant = await getCurrentTenant(auth);

  const [stores, recent] = await Promise.all([
    loadStores(tenant.id),
    loadRecent(tenant.id),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <EntryShell
      title="Log ad spend"
      sub="Record ad-platform spend for a single store and day. Feeds Daily P&L immediately."
      userEmail={user?.email ?? null}
      role={role}
    >
      {params.ok ? (
        <div
          className="auth-err"
          style={{
            background: "var(--accent-bg)",
            color: "var(--accent)",
            border: "1px solid var(--accent-bg-strong)",
          }}
        >
          Saved: {params.ok}
        </div>
      ) : null}
      {params.err ? (
        <div className="auth-err">Could not save — check your inputs or try again.</div>
      ) : null}

      <AdsForm stores={stores} recent={recent} today={today} />
    </EntryShell>
  );
}

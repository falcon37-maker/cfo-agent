import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/auth/roles";
import { EntryShell } from "@/components/entry/EntryShell";
import { getCurrentTenant } from "@/lib/tenant";
import { fmtDate, fmtMoney } from "@/lib/format";
import {
  submitManualRevenueAction,
  deleteManualRevenueAction,
} from "./actions";
import { CheckCircle2, AlertCircle, Trash2 } from "lucide-react";

export const dynamic = "force-dynamic";

const REVENUE_TYPES = [
  "Coaching",
  "Consulting",
  "One-time Sale",
  "Subscription",
  "Other",
] as const;

const ERR_MAP: Record<string, string> = {
  invalid_date: "Pick a valid date.",
  invalid_type: "Select a revenue type.",
  invalid_amount: "Amount must be a positive number.",
  missing_id: "Missing entry id.",
};

type StoreOption = { id: string; name: string };
type Entry = {
  id: string;
  date: string;
  store_id: string | null;
  revenue_type: string;
  description: string | null;
  amount: number;
  notes: string | null;
  created_at: string;
};

async function loadStores(tenantId: string): Promise<StoreOption[]> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("stores")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .neq("id", "PORTFOLIO")
    .neq("id", "__BACKFILL_DEDUPE__")
    .order("id");
  return (data ?? []) as StoreOption[];
}

async function loadEntries(tenantId: string): Promise<Entry[]> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("manual_revenue_entries")
    .select("id, date, store_id, revenue_type, description, amount, notes, created_at")
    .eq("tenant_id", tenantId)
    .order("date", { ascending: false })
    .limit(100);
  return ((data ?? []) as Entry[]).map((e) => ({
    ...e,
    amount: Number(e.amount),
  }));
}

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const params = await searchParams;
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  const role = getRole(user?.email);
  const tenant = await getCurrentTenant(auth);

  const [stores, entries] = await Promise.all([
    loadStores(tenant.id),
    loadEntries(tenant.id),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const total = entries.reduce((s, e) => s + e.amount, 0);

  const errMessage = params.err ? (ERR_MAP[params.err] ?? params.err) : null;

  return (
    <EntryShell
      title="Log revenue"
      sub="For revenue that doesn't come from any API — coaching, consulting, one-off sales. Feeds the dashboard's TOTAL REV when manual entries exist."
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
          <CheckCircle2 size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {decodeURIComponent(params.ok)}
        </div>
      ) : null}
      {errMessage ? (
        <div className="auth-err">
          <AlertCircle size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {errMessage}
        </div>
      ) : null}

      <form
        action={submitManualRevenueAction}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <label className="field">
          <span className="field-label">Date</span>
          <div className="field-input">
            <input type="date" name="date" defaultValue={today} required />
          </div>
        </label>

        <label className="field">
          <span className="field-label">Store</span>
          <div className="field-input">
            <select name="store" defaultValue="">
              <option value="">— General (no store) —</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.name}
                </option>
              ))}
            </select>
          </div>
        </label>

        <label className="field">
          <span className="field-label">Revenue type</span>
          <div className="field-input">
            <select name="revenue_type" defaultValue="Coaching" required>
              {REVENUE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </label>

        <label className="field">
          <span className="field-label">Amount</span>
          <div className="field-input">
            <input
              type="number"
              name="amount"
              step="0.01"
              min="0"
              required
              placeholder="500.00"
            />
          </div>
        </label>

        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span className="field-label">Description</span>
          <div className="field-input">
            <input
              type="text"
              name="description"
              placeholder="Student: Maria — 3-month package"
              maxLength={240}
            />
          </div>
        </label>

        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <span className="field-label">Notes (optional)</span>
          <div className="field-input">
            <textarea name="notes" rows={2} maxLength={500} />
          </div>
        </label>

        <button
          type="submit"
          className="primary-btn"
          style={{ gridColumn: "1 / -1", justifySelf: "start" }}
        >
          Log revenue
        </button>
      </form>

      <div className="card table-card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Recent entries</div>
            <div className="card-sub">
              {entries.length} entr{entries.length === 1 ? "y" : "ies"} · total{" "}
              {fmtMoney(total)}
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Store</th>
                <th>Type</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.date)}</td>
                  <td className="muted">{e.store_id ?? "—"}</td>
                  <td>{e.revenue_type}</td>
                  <td
                    className="muted"
                    style={{
                      maxWidth: 280,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.description ?? "—"}
                  </td>
                  <td className="num">{fmtMoney(e.amount)}</td>
                  <td>
                    <form action={deleteManualRevenueAction} style={{ display: "inline" }}>
                      <input type="hidden" name="id" value={e.id} />
                      <button
                        type="submit"
                        className="ghost-btn"
                        style={{ fontSize: 11, color: "var(--negative)" }}
                      >
                        <Trash2 size={12} strokeWidth={2} />
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 24, color: "var(--muted)" }}>
                    No manual revenue logged yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </EntryShell>
  );
}

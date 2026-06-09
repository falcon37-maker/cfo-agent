// "chargebacks" — Chargeblast alert data.
//
// DB table used:
//   chargeblast_alerts
//     - id (Chargeblast alert id)
//     - store_id (mapped via stores.chargeblast_descriptor)
//     - merchant_descriptor, card_brand, alert_type, amount, currency
//     - status (pending / won / lost / refunded / ...)
//     - reason, order_id, customer_email
//     - chargeblast_created_at, chargeblast_updated_at
//
// Possible questions this handles:
//   - "how many chargebacks this month?"
//   - "any pending chargebacks?"
//   - "show chargebacks for NOVA"
//   - "what's the chargeback ratio?"
//   - "lost chargebacks last 30 days"
//   - "recent chargeback alerts"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const storeId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9_]+$/);

const rangeSchema = z
  .object({
    days: z.number().int().positive().max(365).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
    store_id: storeId.optional(),
    status: z.enum(["pending", "won", "lost", "refunded"]).optional(),
  })
  .refine(
    (v) => v.days != null || (v.from != null && v.to != null),
    "Provide either { days } or { from, to }",
  );

type RangeInput = z.infer<typeof rangeSchema>;

function resolveRange(input: RangeInput) {
  if (input.from && input.to) {
    const days = diffDays(input.from, input.to) + 1;
    return { from: input.from, to: input.to, days };
  }
  const days = input.days ?? 30;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const chargebacksCategory: CategoryModule = {
  id: "chargebacks",
  name: "Chargebacks",

  description:
    "Chargeback alerts from Chargeblast — counts by status (pending/won/lost/refunded), per-store breakdown, recent alerts, totals.",

  examples: [
    "any chargebacks today?",
    "how many chargebacks this month?",
    "show pending chargebacks",
    "NOVA chargebacks last 30 days",
    "what's the chargeback total?",
    "list recent chargeback alerts",
    "lost chargebacks",
  ],

  prompt: `# Mode: Chargebacks

The user is asking about chargeback alerts. Source: chargeblast_alerts table.

Reply rules:
- Status meanings: pending = still in alert window, won = dispute won, lost = chargeback finalized against us, refunded = we refunded preemptively.
- When summarizing, lead with the count + dollar impact of "lost" + "pending" — those are the active concerns.
- Don't list every single alert unless they ask for recent ones.
- If they ask about ratio/health, mention the count without inventing thresholds.`,

  queries: [
    {
      id: "summary_by_status",
      description:
        "Count + total amount grouped by status for a date range. Best for 'how many chargebacks?' / 'chargeback summary'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        let q = sb
          .from("chargeblast_alerts")
          .select("status, store_id, amount")
          .eq("tenant_id", ctx.tenantId)
          .gte("chargeblast_created_at", `${spec.from}T00:00:00Z`)
          .lte("chargeblast_created_at", `${spec.to}T23:59:59Z`);
        if (raw.store_id) q = q.eq("store_id", raw.store_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Array<{
          status: string | null;
          store_id: string | null;
          amount: number | null;
        }>;
        const byStatus: Record<string, { count: number; amount: number }> = {};
        let total = 0;
        let totalAmount = 0;
        for (const r of rows) {
          const s = (r.status ?? "unknown").toLowerCase();
          const cur = byStatus[s] ?? { count: 0, amount: 0 };
          cur.count += 1;
          cur.amount += Number(r.amount ?? 0);
          byStatus[s] = cur;
          total += 1;
          totalAmount += Number(r.amount ?? 0);
        }
        return {
          range: spec,
          store_id: raw.store_id ?? "all",
          total_count: total,
          total_amount: round(totalAmount),
          by_status: Object.entries(byStatus).map(([status, agg]) => ({
            status,
            count: agg.count,
            amount: round(agg.amount),
          })),
        };
      },
      table_threshold: null,
    },
    {
      id: "per_store_chargebacks",
      description:
        "Per-store chargeback counts + amounts. Use when comparing stores or finding the worst offender.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        const { data, error } = await sb
          .from("chargeblast_alerts")
          .select("store_id, amount, status")
          .eq("tenant_id", ctx.tenantId)
          .gte("chargeblast_created_at", `${spec.from}T00:00:00Z`)
          .lte("chargeblast_created_at", `${spec.to}T23:59:59Z`);
        if (error) throw new Error(error.message);
        const byStore = new Map<
          string,
          { count: number; amount: number; lost: number; pending: number }
        >();
        for (const r of (data ?? []) as Array<{
          store_id: string | null;
          amount: number | null;
          status: string | null;
        }>) {
          const k = r.store_id ?? "unmapped";
          const cur =
            byStore.get(k) ?? { count: 0, amount: 0, lost: 0, pending: 0 };
          cur.count += 1;
          cur.amount += Number(r.amount ?? 0);
          const s = (r.status ?? "").toLowerCase();
          if (s === "lost") cur.lost += 1;
          if (s === "pending") cur.pending += 1;
          byStore.set(k, cur);
        }
        return Array.from(byStore.entries()).map(([store_id, t]) => ({
          store_id,
          count: t.count,
          total_amount: round(t.amount),
          lost: t.lost,
          pending: t.pending,
        }));
      },
      table_threshold: null,
    },
    {
      id: "recent_alerts",
      description:
        "List recent chargeback alerts (newest first). Use when user asks 'show me chargebacks' / 'recent alerts'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        let q = sb
          .from("chargeblast_alerts")
          .select(
            "store_id, status, amount, card_brand, reason, customer_email, chargeblast_created_at",
          )
          .eq("tenant_id", ctx.tenantId)
          .gte("chargeblast_created_at", `${spec.from}T00:00:00Z`)
          .lte("chargeblast_created_at", `${spec.to}T23:59:59Z`)
          .order("chargeblast_created_at", { ascending: false })
          .limit(50);
        if (raw.store_id) q = q.eq("store_id", raw.store_id);
        if (raw.status) q = q.eq("status", raw.status);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return (data ?? []).map((r) => ({
          date: String(r.chargeblast_created_at ?? "").slice(0, 10),
          store_id: r.store_id ?? "—",
          status: r.status ?? "—",
          amount: round(Number(r.amount ?? 0)),
          card: r.card_brand ?? "—",
          reason: r.reason ?? "—",
        }));
      },
      table_threshold: 8,
      table_columns: ["date", "store_id", "status", "amount", "card", "reason"],
      table_column_labels: {
        date: "Date",
        store_id: "Store",
        status: "Status",
        amount: "Amount",
        card: "Card",
        reason: "Reason",
      },
    },
  ],

  fallback_suggestions: [
    "which store has the most chargebacks?",
    "show me lost chargebacks",
    "any pending alerts to review?",
  ],
};

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

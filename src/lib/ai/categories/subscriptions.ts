// "subscriptions" — Phoenix/Solvpath subscription metrics.
//
// DB tables used:
//   phx_summary_snapshots
//     - store_id           PHX store (NOVA/NURA/KOVA) or 'PORTFOLIO' aggregate
//     - range_from/_to     date this row represents
//     - active_subscribers, cancelled_subscribers, subscribers_in_salvage
//     - revenue_initial, revenue_recurring, revenue_salvage, revenue_total
//     - initial_subscription_count, recurring_subscription_count, ...
//     - target_cac, subscriptions_to_bill, total_transactions_mtd
//
// Possible questions this handles:
//   - "how many active subscribers do we have?"
//   - "what's the active sub count?"
//   - "MRR for NOVA"
//   - "subscription revenue this month"
//   - "how is the recurring bucket doing?"
//   - "how many new subs this week?"
//   - "stick rate"
//   - "salvage performance"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  loadLatestPortfolioSnapshot,
  loadPhxDailyRows,
} from "@/lib/phx/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phxStoreId = z.enum(["NOVA", "NURA", "KOVA"]);

const rangeSchema = z
  .object({
    days: z.number().int().positive().max(365).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
    store_id: phxStoreId.optional(),
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
  const days = input.days ?? 7;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const subscriptionsCategory: CategoryModule = {
  id: "subscriptions",
  name: "Subscriptions",

  description:
    "Subscription metrics from Phoenix/Solvpath: active subscriber count, cancelled count, MRR estimate, initial/recurring/salvage revenue breakdown, per-store subscription performance.",

  examples: [
    "how many active subscribers?",
    "what's the MRR?",
    "subscription revenue this week",
    "how is NOVA's subscription doing?",
    "show me recurring vs salvage breakdown",
    "stick rate",
    "new subs this month",
    "cancelled subs last 30 days",
  ],

  prompt: `# Mode: Subscriptions

The user is asking about the subscription side of the business — Phoenix/Solvpath data only. Shopify front-end revenue is NOT part of this conversation.

Reply rules:
- Active subscribers comes from the latest PORTFOLIO snapshot.
- Subscription revenue = Initial + Recurring + Salvage (always $29.99/billing).
- When asked about MRR, estimate as active_subscribers × $29.99 and call it an estimate.
- For "stick rate" = active / (active + cancelled), expressed as a percentage.
- Lead with the headline number, one short sentence of context.
- Don't bring in Shopify/P&L numbers unless the user asks.`,

  queries: [
    {
      id: "latest_portfolio_snapshot",
      description:
        "Get the most recent PORTFOLIO-wide subscriber counts (active, cancelled, in salvage). Best for 'how many subs?' / 'MRR?' / 'stick rate?'",
      params_schema: z.object({}),
      run: async (_in, ctx) => {
        const snap = await loadLatestPortfolioSnapshot(ctx.tenantId);
        if (!snap) {
          return { available: false, note: "No PORTFOLIO snapshot found yet." };
        }
        const active = Number(snap.active_subscribers ?? 0);
        const cancelled = Number(snap.cancelled_subscribers ?? 0);
        const stick =
          active + cancelled > 0
            ? (active / (active + cancelled)) * 100
            : null;
        return {
          available: true,
          active_subscribers: active,
          cancelled_subscribers: cancelled,
          subscribers_in_salvage: Number(snap.subscribers_in_salvage ?? 0),
          mrr_estimate_usd: round(active * 29.99),
          stick_rate_pct: stick != null ? round(stick, 1) : null,
          snapshot_date: snap.range_to,
          scraped_at: snap.scraped_at,
        };
      },
      table_threshold: null,
    },
    {
      id: "revenue_breakdown",
      description:
        "Subscription revenue split by bucket (initial / recurring / salvage / upsell / direct) over a date range. Optional store_id filter to one PHX store.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const stores = raw.store_id
          ? [raw.store_id]
          : ["NOVA", "NURA", "KOVA"];
        const rows = await loadPhxDailyRows(
          spec.from,
          spec.to,
          stores,
          ctx.tenantId,
        );
        const totals = {
          direct: 0,
          initial: 0,
          recurring: 0,
          salvage: 0,
          upsell: 0,
          total: 0,
        };
        for (const r of rows) {
          if (!r.range_from || r.range_from !== r.range_to) continue;
          totals.direct += Number(r.revenue_direct ?? 0);
          totals.initial += Number(r.revenue_initial ?? 0);
          totals.recurring += Number(r.revenue_recurring ?? 0);
          totals.salvage += Number(r.revenue_salvage ?? 0);
          totals.upsell += Number(r.revenue_upsell ?? 0);
          totals.total += Number(r.revenue_total ?? 0);
        }
        return {
          range: spec,
          stores,
          direct: round(totals.direct),
          initial: round(totals.initial),
          recurring: round(totals.recurring),
          salvage: round(totals.salvage),
          upsell: round(totals.upsell),
          total: round(totals.total),
        };
      },
      table_threshold: null,
    },
    {
      id: "per_store_subs_revenue",
      description:
        "Per-store breakdown of subscription revenue (Initial + Recurring + Salvage) for NOVA/NURA/KOVA over a range. Use for comparisons.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const rows = await loadPhxDailyRows(
          spec.from,
          spec.to,
          ["NOVA", "NURA", "KOVA"],
          ctx.tenantId,
        );
        const byStore = new Map<
          string,
          { initial: number; recurring: number; salvage: number; total: number }
        >();
        for (const r of rows) {
          if (!r.range_from || r.range_from !== r.range_to) continue;
          const cur = byStore.get(r.store_id) ?? {
            initial: 0,
            recurring: 0,
            salvage: 0,
            total: 0,
          };
          cur.initial += Number(r.revenue_initial ?? 0);
          cur.recurring += Number(r.revenue_recurring ?? 0);
          cur.salvage += Number(r.revenue_salvage ?? 0);
          cur.total = cur.initial + cur.recurring + cur.salvage;
          byStore.set(r.store_id, cur);
        }
        return Array.from(byStore.entries()).map(([store_id, t]) => ({
          store_id,
          initial: round(t.initial),
          recurring: round(t.recurring),
          salvage: round(t.salvage),
          total: round(t.total),
        }));
      },
      table_threshold: null, // 3 stores max, always fits in text
    },
    {
      id: "daily_subs_revenue",
      description:
        "Per-day subscription revenue timeline. Use when the user wants to see day-by-day subs trends.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const stores = raw.store_id
          ? [raw.store_id]
          : ["NOVA", "NURA", "KOVA"];
        const rows = await loadPhxDailyRows(
          spec.from,
          spec.to,
          stores,
          ctx.tenantId,
        );
        // Aggregate per-day across stores.
        const byDate = new Map<
          string,
          { initial: number; recurring: number; salvage: number; total: number }
        >();
        for (const r of rows) {
          if (!r.range_from || r.range_from !== r.range_to) continue;
          const cur = byDate.get(r.range_from) ?? {
            initial: 0,
            recurring: 0,
            salvage: 0,
            total: 0,
          };
          cur.initial += Number(r.revenue_initial ?? 0);
          cur.recurring += Number(r.revenue_recurring ?? 0);
          cur.salvage += Number(r.revenue_salvage ?? 0);
          cur.total = cur.initial + cur.recurring + cur.salvage;
          byDate.set(r.range_from, cur);
        }
        return Array.from(byDate.entries())
          .sort()
          .map(([date, t]) => ({
            date,
            initial: round(t.initial),
            recurring: round(t.recurring),
            salvage: round(t.salvage),
            total: round(t.total),
          }));
      },
      table_threshold: 10,
      table_columns: ["date", "initial", "recurring", "salvage", "total"],
      table_column_labels: {
        initial: "Initial",
        recurring: "Recurring",
        salvage: "Salvage",
        total: "Total",
      },
    },
    {
      id: "new_vs_cancelled",
      description:
        "Get the count of new subscribers and cancelled subscribers in a period. Use for 'how many new subs?' / 'cancellations'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        const { data } = await sb
          .from("phx_summary_snapshots")
          .select(
            "store_id, range_from, range_to, new_subscribers, cancelled_subscribers_period",
          )
          .eq("tenant_id", ctx.tenantId)
          .gte("range_from", spec.from)
          .lte("range_to", spec.to);
        let newSubs = 0;
        let cancelled = 0;
        for (const r of (data ?? []) as Array<{
          range_from: string;
          range_to: string;
          new_subscribers: number | null;
          cancelled_subscribers_period: number | null;
        }>) {
          if (r.range_from !== r.range_to) continue;
          newSubs += Number(r.new_subscribers ?? 0);
          cancelled += Number(r.cancelled_subscribers_period ?? 0);
        }
        return {
          range: spec,
          new_subscribers: newSubs,
          cancelled_subscribers: cancelled,
          net_change: newSubs - cancelled,
        };
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "what's the MRR estimate?",
    "show subscription revenue breakdown",
    "how many new subs this week?",
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

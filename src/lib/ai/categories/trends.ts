// "trends" — period-over-period comparisons + week-over-week, month-over-month.
//
// DB tables used:
//   daily_pnl              (Shopify side aggregated)
//   phx_summary_snapshots  (subscription side aggregated)
//   via loadPnlLedger      (combined ledger)
//
// Possible questions this handles:
//   - "compare this week to last week"
//   - "how does May compare to April?"
//   - "is revenue trending up?"
//   - "week-over-week net profit"
//   - "is margin getting better?"

import { z } from "zod";
import { loadPnlLedger } from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const compareSchema = z.object({
  /** Window length in days for BOTH periods. Default 7 (week vs week). */
  days: z.number().int().positive().max(180).optional(),
});

type CompareInput = z.infer<typeof compareSchema>;

export const trendsCategory: CategoryModule = {
  id: "trends",
  name: "Trends",

  description:
    "Period-over-period comparisons. Compares the current rolling window against the prior same-length window. Use when the user says 'compare', 'vs last week/month', 'trending'.",

  examples: [
    "compare this week to last week",
    "how does this month compare to last month?",
    "is revenue trending up?",
    "week-over-week net profit",
    "is ad spend higher than last week?",
    "are subs growing?",
  ],

  prompt: `# Mode: Trends

The user is comparing periods. The data has two parallel totals: this_period and prior_period.

Reply rules:
- Lead with the direction (up / down / flat) and the percentage change.
- One sentence on what's driving it (the biggest contributor).
- Use round numbers when the % is the point ("up 12%", not "up 11.94%").
- Don't list every metric — pick the one the user asked about.`,

  queries: [
    {
      id: "this_vs_last",
      description:
        "Compare the most recent rolling window against the immediately prior window of the same length. Default 7 days each.",
      params_schema: compareSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as CompareInput;
        const days = raw.days ?? 7;
        const today = ctx.today;
        const curTo = today;
        const curFrom = addDays(curTo, -(days - 1));
        const priorTo = addDays(curFrom, -1);
        const priorFrom = addDays(priorTo, -(days - 1));

        const [cur, prior] = await Promise.all([
          loadPnlLedger({ from: curFrom, to: curTo }, "all", ctx.tenantId),
          loadPnlLedger(
            { from: priorFrom, to: priorTo },
            "all",
            ctx.tenantId,
          ),
        ]);

        const pct = (a: number, b: number) =>
          b === 0 ? null : round(((a - b) / b) * 100, 1);

        return {
          window_days: days,
          current: {
            from: curFrom,
            to: curTo,
            total_revenue: round(cur.totals.total_revenue),
            ad_spend: round(cur.totals.ad_spend),
            net_profit: round(cur.totals.net_profit),
            orders: cur.totals.orders,
            margin_pct: round(cur.totals.margin_pct, 1),
          },
          prior: {
            from: priorFrom,
            to: priorTo,
            total_revenue: round(prior.totals.total_revenue),
            ad_spend: round(prior.totals.ad_spend),
            net_profit: round(prior.totals.net_profit),
            orders: prior.totals.orders,
            margin_pct: round(prior.totals.margin_pct, 1),
          },
          deltas_pct: {
            total_revenue: pct(
              cur.totals.total_revenue,
              prior.totals.total_revenue,
            ),
            ad_spend: pct(cur.totals.ad_spend, prior.totals.ad_spend),
            net_profit: pct(cur.totals.net_profit, prior.totals.net_profit),
            orders: pct(cur.totals.orders, prior.totals.orders),
          },
        };
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "which metric improved the most?",
    "show this month vs last month",
    "what's driving the change?",
  ],
};

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

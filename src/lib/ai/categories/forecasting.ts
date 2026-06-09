// "forecasting" — simple projections from existing data.
//
// We don't run statistical models here; we extrapolate from recent averages.
// The system prompt explicitly tells the assistant to label these as
// estimates and explain the assumption.
//
// DB tables used:
//   daily_pnl
//   phx_summary_snapshots (active_subscribers for MRR projection)
//
// Possible questions this handles:
//   - "what's the projected MRR next month?"
//   - "expected revenue for the rest of the month?"
//   - "if this trend continues..."
//   - "projected ad spend this month"

import { z } from "zod";
import { loadPnlLedger } from "@/lib/pnl/queries";
import { loadLatestPortfolioSnapshot } from "@/lib/phx/queries";
import type { CategoryModule } from "./_base";

export const forecastingCategory: CategoryModule = {
  id: "forecasting",
  name: "Forecasting",

  description:
    "Simple projections from recent trends — MRR estimate, end-of-month revenue extrapolation, run-rate calculations. Use when the user asks 'projected', 'expected', 'if this trend continues'.",

  examples: [
    "what's the projected MRR next month?",
    "expected revenue for the rest of the month",
    "if this trend continues, where do we end up?",
    "run-rate for ad spend",
    "monthly revenue projection",
  ],

  prompt: `# Mode: Forecasting

You're projecting from recent data. These are estimates, NOT promises.

Reply rules:
- ALWAYS label the answer as an estimate and explain the assumption in one short clause (e.g. "based on the last 7 days holding steady").
- Don't pretend you have a statistical model — you're extrapolating averages.
- If asked about MRR specifically: active_subscribers × $29.99 = MRR estimate. Note that this assumes flat retention.
- Avoid giving precise-looking numbers — use $24K not $24,381 when the precision is fake.`,

  queries: [
    {
      id: "mrr_estimate",
      description:
        "Estimate Monthly Recurring Revenue from active subscribers × $29.99 (flat-retention assumption).",
      params_schema: z.object({}),
      run: async (_in, ctx) => {
        const snap = await loadLatestPortfolioSnapshot(ctx.tenantId);
        if (!snap || snap.active_subscribers == null) {
          return { available: false, note: "No portfolio snapshot yet." };
        }
        const active = Number(snap.active_subscribers);
        return {
          available: true,
          active_subscribers: active,
          assumed_price_usd: 29.99,
          mrr_estimate_usd: round(active * 29.99),
          arr_estimate_usd: round(active * 29.99 * 12),
          assumption:
            "Assumes flat retention and $29.99 per active subscriber, before any salvage losses or new growth.",
        };
      },
      table_threshold: null,
    },
    {
      id: "month_run_rate",
      description:
        "Project end-of-month total revenue from average daily revenue MTD. Use for 'projected May revenue' / 'where will we land?'",
      params_schema: z.object({}),
      run: async (_in, ctx) => {
        const today = ctx.today;
        const [y, m] = today.split("-").map(Number);
        const mtdFrom = `${today.slice(0, 7)}-01`;
        const daysElapsed = Number(today.slice(8, 10));
        const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

        const ledger = await loadPnlLedger(
          { from: mtdFrom, to: today },
          "all",
          ctx.tenantId,
        );
        const mtdRevenue = ledger.totals.total_revenue;
        const dailyAvg = daysElapsed > 0 ? mtdRevenue / daysElapsed : 0;
        const projected = dailyAvg * daysInMonth;

        return {
          mtd_from: mtdFrom,
          mtd_to: today,
          days_elapsed: daysElapsed,
          days_in_month: daysInMonth,
          mtd_revenue: round(mtdRevenue),
          daily_average: round(dailyAvg),
          projected_month_total: round(projected),
          assumption:
            "Assumes the rest of the month matches the current daily average. Doesn't account for seasonality, weekend effects, or known events.",
        };
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "what's the MRR estimate?",
    "where will we land this month?",
    "what if subs grow 5%?",
  ],
};

function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

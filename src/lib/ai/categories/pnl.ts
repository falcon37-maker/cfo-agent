// "pnl" handles Profit & Loss questions — revenue, COGS, fees, refunds,
// ad spend, net profit, margin.
//
// Data source rules:
//   - All-stores totals  → loadBlendedDashboardData (same math as the / dashboard)
//   - Per-store breakdown → loadPnlLedger (one store at a time has no PHX
//     double-count concern)
//
// This keeps the chat numbers identical to what the user sees on screen.

import { z } from "zod";
import {
  loadBlendedDashboardData,
  loadPnlLedger,
} from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const storeId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9_]+$/, "store_id must be uppercase letters/numbers/_");

const rangeSchema = z
  .object({
    days: z.number().int().positive().max(365).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
  })
  .refine(
    (v) => v.days != null || (v.from != null && v.to != null),
    "Provide either { days } or { from, to }",
  );

const storeRangeSchema = rangeSchema.and(
  z.object({ store_id: storeId }),
);

type RangeInput = z.infer<typeof rangeSchema>;
type StoreRangeInput = z.infer<typeof storeRangeSchema>;

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

export const pnlCategory: CategoryModule = {
  id: "pnl",
  name: "P&L Analysis",

  description:
    "Profit & Loss detail — revenue, COGS, fees, refunds, ad spend, net profit, margins. Use when the user wants the full P&L picture for a store or the whole business.",

  examples: [
    "show me NOVA's P&L for last 30 days",
    "what's net profit this week?",
    "P&L for May",
    "which store has the best margin?",
    "show me daily profit",
  ],

  prompt: `# Mode: P&L Analysis

The user is asking about Profit & Loss. The data is loaded by loadPnlLedger — the exact same function the /pnl page uses, so numbers will match what they see on screen.

Rules for P&L-mode replies:
- Revenue = Shopify "Net sales" = gross_sales − refunds (refunds already removed).
- Net profit = revenue − COGS − fees − ad_spend  (refunds NOT subtracted again — they're already out of revenue).
- Margin = net_profit / total_revenue × 100.
- When totals are given, lead with net profit (the thing the owner actually cares about) and call out the biggest cost driver if it stands out.
- Always state the date range.
- If the user asked about a specific store, only talk about that store. Don't bring in others unless asked.
- Don't list every metric. Pick the 2-3 that answer the question.`,

  queries: [
    {
      id: "totals_all_stores",
      description:
        "Aggregated P&L totals across all stores. Best for 'how was P&L this week?' / 'what's net profit?'. Uses the same blended-dashboard math as the / dashboard KPIs.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const dash = await loadBlendedDashboardData(ctx.tenantId, spec);
        const t = dash.periodTotals;
        return {
          range: dash.range,
          shopify_revenue: round(t.shopify_revenue),
          phx_revenue: round(t.phx_revenue),
          manual_revenue: round(t.manual_revenue),
          total_revenue: round(t.total_revenue),
          cogs: round(t.shopify_cogs),
          refunds: round(t.shopify_refunds),
          ad_spend: round(t.shopify_ad_spend),
          shopify_net_profit: round(t.shopify_net_profit),
          phx_net_contribution: round(t.phx_net_contribution),
          net_profit: round(t.total_net_profit),
          orders: t.shopify_orders,
          roas: round(t.roas, 2),
          margin_pct: round(t.margin_pct, 1),
        };
      },
      table_threshold: null,
    },
    {
      id: "totals_for_store",
      description:
        "P&L totals for ONE store over a range. Use when the user names a store ('NOVA's P&L', 'how did NURA do').",
      params_schema: storeRangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as StoreRangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(
          spec,
          [raw.store_id],
          ctx.tenantId,
        );
        return {
          store_id: raw.store_id,
          range: spec,
          revenue: round(ledger.totals.revenue),
          subs_revenue: round(ledger.totals.subs_revenue),
          total_revenue: round(ledger.totals.total_revenue),
          cogs: round(ledger.totals.cogs),
          fees: round(ledger.totals.fees),
          refunds: round(ledger.totals.refunds),
          ad_spend: round(ledger.totals.ad_spend),
          gross_profit: round(ledger.totals.gross_profit),
          net_profit: round(ledger.totals.net_profit),
          orders: ledger.totals.orders,
          roas: round(ledger.totals.roas, 2),
          margin_pct: round(ledger.totals.margin_pct, 1),
        };
      },
      table_threshold: null,
    },
    {
      id: "daily_for_store",
      description:
        "Per-day P&L rows for ONE store. Use when the user wants the timeline / ledger view ('show me NOVA day by day', 'daily P&L for NURA').",
      params_schema: storeRangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as StoreRangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(
          spec,
          [raw.store_id],
          ctx.tenantId,
        );
        return ledger.rows.map((r) => ({
          date: r.date,
          revenue: round(r.revenue),
          subs_revenue: round(r.subs_revenue),
          total_revenue: round(r.total_revenue),
          cogs: round(r.cogs),
          fees: round(r.fees),
          refunds: round(r.refunds),
          ad_spend: round(r.ad_spend),
          net_profit: round(r.net_profit),
          margin_pct: round(r.margin_pct, 1),
          orders: r.order_count,
        }));
      },
      table_threshold: 10,
      table_columns: [
        "date",
        "total_revenue",
        "cogs",
        "ad_spend",
        "fees",
        "net_profit",
        "margin_pct",
      ],
      table_column_labels: {
        total_revenue: "Revenue",
        cogs: "COGS",
        ad_spend: "Ad Spend",
        fees: "Fees",
        net_profit: "Net Profit",
        margin_pct: "Margin %",
      },
    },
    {
      id: "daily_all_stores",
      description:
        "Per-day P&L rows aggregated across all stores. Use when the user wants the timeline view without a specific store ('daily P&L', 'show me each day'). Uses blended-dashboard math (matches / dashboard).",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const dash = await loadBlendedDashboardData(ctx.tenantId, spec);
        return dash.daily.map((r) => ({
          date: r.date,
          shopify_revenue: round(r.shopify_revenue),
          phx_revenue: round(r.phx_revenue),
          total_revenue: round(r.total_revenue),
          cogs: round(r.shopify_cogs),
          ad_spend: round(r.shopify_ad_spend),
          net_profit: round(r.total_net_profit),
          orders: r.shopify_orders,
        }));
      },
      table_threshold: 10,
      table_columns: [
        "date",
        "total_revenue",
        "cogs",
        "ad_spend",
        "net_profit",
      ],
      table_column_labels: {
        total_revenue: "Revenue",
        cogs: "COGS",
        ad_spend: "Ad Spend",
        net_profit: "Net Profit",
      },
    },
  ],

  fallback_suggestions: [
    "which day had the worst margin?",
    "show me ad spend trend",
    "compare this period with last",
  ],
};

// ─── helpers ────────────────────────────────────────────────────────────
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

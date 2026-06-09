// "revenue" handles total-revenue and revenue-mix questions.
// Source of truth: loadPnlLedger("all", tenantId) — same function the /pnl
// page uses, so AI numbers always match what the user sees on screen.

import { z } from "zod";
import { loadBlendedDashboardData } from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Either { days } or { from, to } — the model picks one, never both.
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

type RangeInput = z.infer<typeof rangeSchema>;

function resolveRange(
  input: RangeInput,
): { from: string; to: string; days: number } {
  if (input.from && input.to) {
    const days = diffDays(input.from, input.to) + 1;
    return { from: input.from, to: input.to, days };
  }
  const days = input.days ?? 7;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const revenueCategory: CategoryModule = {
  id: "revenue",
  name: "Revenue",

  description:
    "Total revenue, revenue mix (Shopify vs subscriptions), period totals. Use this when the user asks 'how much money came in' across the business.",

  examples: [
    "how is revenue this week?",
    "total revenue for May",
    "revenue last 30 days",
    "what's our subs vs shopify split?",
    "revenue from April 1 to April 30",
  ],

  prompt: `# Mode: Revenue

You are answering a revenue question. The query you (the assistant) chose has already run and the data is in this turn's tool result.

Rules for revenue-mode replies:
- Lead with the headline number for the range, then mention what's notable about it (the mix, a comparison, an anomaly).
- "Total revenue" = revenue + subs_revenue. Don't conflate them — Shopify front-end and PHX subs are different streams.
- Always state the date range you used so the user knows what they're looking at.
- One short paragraph. No bulleted lists of every metric.
- Don't quote ROAS or margin in a revenue-only question unless asked.`,

  queries: [
    {
      id: "totals",
      description:
        "Get just the period totals (small payload). Best for headline numbers like 'how much did we make this week?'. Uses the same blended-dashboard math the / dashboard KPIs use, so AI numbers match the UI exactly.",
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
          orders: t.shopify_orders,
          source_mix: {
            shopify: round(dash.sourceMix.shopify),
            phx: round(dash.sourceMix.phx),
          },
        };
      },
      table_threshold: null, // always text — it's just one row of totals
    },
    {
      id: "daily_series",
      description:
        "Get daily revenue rows over a range. Use when the user wants to see the timeline ('show me daily revenue', 'revenue per day'). Uses blended-dashboard math (matches / dashboard).",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const dash = await loadBlendedDashboardData(ctx.tenantId, spec);
        return dash.daily.map((r) => ({
          date: r.date,
          shopify_revenue: round(r.shopify_revenue),
          phx_revenue: round(r.phx_revenue),
          manual_revenue: round(r.manual_revenue),
          total_revenue: round(r.total_revenue),
          orders: r.shopify_orders,
        }));
      },
      table_threshold: 10,
      table_columns: [
        "date",
        "shopify_revenue",
        "phx_revenue",
        "manual_revenue",
        "total_revenue",
        "orders",
      ],
      table_column_labels: {
        date: "Date",
        shopify_revenue: "Shopify",
        phx_revenue: "Subscriptions",
        manual_revenue: "Manual",
        total_revenue: "Total",
        orders: "Orders",
      },
    },
  ],

  fallback_suggestions: [
    "how does this compare to last week?",
    "which store drove the most revenue?",
    "show daily revenue for this month",
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

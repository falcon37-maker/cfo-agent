// "stores" — store-level performance comparisons and listings.
//
// DB tables used:
//   stores               (registry: id, name, currency, timezone, fees, etc.)
//   daily_pnl            (per-store rollup)
//   phx_summary_snapshots (subscription side for PHX stores)
//
// Possible questions this handles:
//   - "which store is performing best?"
//   - "compare NOVA and NURA"
//   - "list all stores"
//   - "store with worst margin"
//   - "rank stores by revenue this month"
//   - "which store has the highest ad spend?"

import { z } from "zod";
import { loadStores, loadPnlLedger } from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

const compareSchema = z.object({
  metric: z
    .enum(["revenue", "net_profit", "ad_spend", "margin", "orders"])
    .default("revenue"),
  days: z.number().int().positive().max(365).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

type RangeInput = z.infer<typeof rangeSchema>;
type CompareInput = z.infer<typeof compareSchema>;

function resolveRange(input: {
  days?: number;
  from?: string;
  to?: string;
}) {
  if (input.from && input.to) {
    const days = diffDays(input.from, input.to) + 1;
    return { from: input.from, to: input.to, days };
  }
  const days = input.days ?? 30;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const storesCategory: CategoryModule = {
  id: "stores",
  name: "Stores",

  description:
    "Per-store performance: listing, ranking, comparisons. Use this when the user asks about stores collectively or wants to compare them on a metric.",

  examples: [
    "list my stores",
    "which store is doing best?",
    "rank stores by revenue",
    "compare NOVA and NURA",
    "store with worst margin",
    "show me all stores",
  ],

  prompt: `# Mode: Stores

The user is asking about stores collectively or comparing them.

Reply rules:
- The business has both PHX subscription stores (NOVA/NURA/KOVA) and Shopify-only dropshipping stores. Mention which is which only when it matters to the answer.
- For "best/worst" questions, name 1-2 stores and the number — don't paginate through everyone.
- For rankings, use the table mode so the user can scan.`,

  queries: [
    {
      id: "list_all",
      description:
        "Get every active store with id, name, currency, fees. Use for 'list my stores' / 'what stores do I have?'",
      params_schema: z.object({}),
      run: async (_in, ctx) => {
        const stores = await loadStores(ctx.tenantId);
        return stores
          .filter((s) => s.id !== "PORTFOLIO")
          .map((s) => ({
            store_id: s.id,
            name: s.name,
            currency: s.currency,
            timezone: s.timezone,
            processing_fee_pct: s.processing_fee_pct,
            type: ["NOVA", "NURA", "KOVA"].includes(s.id)
              ? "subscription"
              : "shopify",
          }));
      },
      table_threshold: 6,
      table_columns: [
        "store_id",
        "name",
        "type",
        "currency",
        "processing_fee_pct",
      ],
      table_column_labels: {
        store_id: "Store",
        name: "Name",
        type: "Type",
        currency: "Currency",
        processing_fee_pct: "Fee %",
      },
      table_column_format: {
        processing_fee_pct: "pct",
      },
    },
    {
      id: "rank_by_metric",
      description:
        "Rank stores by a chosen metric (revenue, net_profit, ad_spend, margin, orders) over a date range.",
      params_schema: compareSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as CompareInput;
        const spec = resolveRange(raw);
        const stores = await loadStores(ctx.tenantId);
        const out: Array<{
          store_id: string;
          name: string;
          revenue: number;
          net_profit: number;
          ad_spend: number;
          orders: number;
          margin_pct: number;
        }> = [];
        for (const s of stores) {
          if (s.id === "PORTFOLIO") continue;
          const ledger = await loadPnlLedger(spec, [s.id], ctx.tenantId);
          const t = ledger.totals;
          out.push({
            store_id: s.id,
            name: s.name,
            revenue: round(t.total_revenue),
            net_profit: round(t.net_profit),
            ad_spend: round(t.ad_spend),
            orders: t.orders,
            margin_pct: round(t.margin_pct, 1),
          });
        }
        const sortKey: keyof (typeof out)[number] =
          raw.metric === "revenue"
            ? "revenue"
            : raw.metric === "net_profit"
              ? "net_profit"
              : raw.metric === "ad_spend"
                ? "ad_spend"
                : raw.metric === "orders"
                  ? "orders"
                  : "margin_pct";
        out.sort(
          (a, b) =>
            (b[sortKey] as number) - (a[sortKey] as number),
        );
        return out;
      },
      table_threshold: 4,
      table_columns: [
        "store_id",
        "revenue",
        "ad_spend",
        "net_profit",
        "orders",
        "margin_pct",
      ],
      table_column_labels: {
        store_id: "Store",
        revenue: "Revenue",
        ad_spend: "Ad Spend",
        net_profit: "Net Profit",
        orders: "Orders",
        margin_pct: "Margin %",
      },
    },
  ],

  fallback_suggestions: [
    "rank stores by net profit",
    "which store has the highest margin?",
    "compare ad spend across stores",
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

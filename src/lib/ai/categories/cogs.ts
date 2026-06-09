// "cogs" — Cost of Goods Sold analysis.
//
// DB tables used:
//   cogs_entries     (manual daily COGS submissions; audit log)
//   products         (per-variant COGS catalog from Shopify)
//   daily_pnl        (cogs column = computed rollup)
//   stores           (default_cogs_per_order)
//
// Possible questions this handles:
//   - "what did COGS look like last month?"
//   - "NOVA's COGS this week"
//   - "average COGS per order"
//   - "highest COGS day"
//   - "show me COGS entries"
//   - "who logged COGS yesterday?"
//   - "products with missing COGS"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadPnlLedger } from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const storeId = z.string().min(1).max(32).regex(/^[A-Z0-9_]+$/);

const rangeSchema = z
  .object({
    days: z.number().int().positive().max(365).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
    store_id: storeId.optional(),
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

export const cogsCategory: CategoryModule = {
  id: "cogs",
  name: "COGS",

  description:
    "Cost of Goods Sold analysis — total COGS over a period, per-store, per-order averages, manual entry audit, products missing COGS.",

  examples: [
    "what was COGS this month?",
    "NOVA COGS last week",
    "highest COGS day",
    "average COGS per order",
    "show me COGS entries",
    "products without COGS",
    "who logged COGS yesterday?",
  ],

  prompt: `# Mode: COGS

The user is asking about Cost of Goods Sold.

Reply rules:
- COGS = what we paid for the products themselves. Doesn't include shipping, fees, or refunds.
- Average COGS per order = total_cogs / order_count.
- If a product has null COGS in the catalog, it's not contributing to the per-order math — call that out when relevant.
- Don't recompute COGS — the numbers come straight from daily_pnl which is already the rollup.`,

  queries: [
    {
      id: "totals",
      description:
        "Total COGS + per-order average for a range. Best for 'what was COGS?' / 'average COGS per order'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(
          spec,
          raw.store_id ? [raw.store_id] : "all",
          ctx.tenantId,
        );
        const avgPerOrder =
          ledger.totals.orders > 0
            ? ledger.totals.cogs / ledger.totals.orders
            : 0;
        return {
          range: spec,
          store_id: raw.store_id ?? "all",
          total_cogs: round(ledger.totals.cogs),
          orders: ledger.totals.orders,
          avg_cogs_per_order: round(avgPerOrder),
        };
      },
      table_threshold: null,
    },
    {
      id: "daily_cogs",
      description:
        "Per-day COGS rows over a range. Use when the user wants the timeline view.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(
          spec,
          raw.store_id ? [raw.store_id] : "all",
          ctx.tenantId,
        );
        return ledger.rows.map((r) => ({
          date: r.date,
          cogs: round(r.cogs),
          orders: r.order_count,
          avg_per_order:
            r.order_count > 0 ? round(r.cogs / r.order_count) : 0,
        }));
      },
      table_threshold: 10,
      table_columns: ["date", "cogs", "orders", "avg_per_order"],
      table_column_labels: {
        cogs: "COGS",
        orders: "Orders",
        avg_per_order: "Avg / Order",
      },
    },
    {
      id: "recent_entries",
      description:
        "List recent manual COGS entries with who submitted them. Use for 'show me COGS entries' / 'who logged COGS'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        let q = sb
          .from("cogs_entries")
          .select("date, store_id, cogs, submitted_by, submitted_at")
          .eq("tenant_id", ctx.tenantId)
          .gte("date", spec.from)
          .lte("date", spec.to)
          .order("submitted_at", { ascending: false })
          .limit(30);
        if (raw.store_id) q = q.eq("store_id", raw.store_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return (data ?? []).map((r) => ({
          date: r.date,
          store_id: r.store_id,
          cogs: round(Number(r.cogs ?? 0)),
          submitted_by: r.submitted_by ?? "—",
          submitted_at: String(r.submitted_at ?? "").slice(0, 10),
        }));
      },
      table_threshold: 8,
      table_columns: [
        "date",
        "store_id",
        "cogs",
        "submitted_by",
        "submitted_at",
      ],
      table_column_labels: {
        date: "Date",
        store_id: "Store",
        cogs: "COGS",
        submitted_by: "By",
        submitted_at: "Logged",
      },
    },
    {
      id: "products_missing_cogs",
      description:
        "Find product variants that have no COGS set in the catalog. Use for 'products without COGS' / data quality checks.",
      params_schema: z.object({
        store_id: storeId.optional(),
      }),
      run: async (rawIn, ctx) => {
        const raw = rawIn as { store_id?: string };
        const sb = supabaseAdmin();
        // products is shared across tenants by store relationship — we
        // scope through the stores table.
        const { data: storesData } = await sb
          .from("stores")
          .select("id")
          .eq("tenant_id", ctx.tenantId);
        const storeIds = (storesData ?? []).map((s) => s.id as string);
        if (storeIds.length === 0) return [];
        let q = sb
          .from("products")
          .select("store_id, sku, title, variant_title, cogs")
          .in("store_id", storeIds)
          .is("cogs", null)
          .limit(100);
        if (raw.store_id) q = q.eq("store_id", raw.store_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return (data ?? []).map((r) => ({
          store_id: r.store_id,
          sku: r.sku ?? "—",
          title: r.title ?? "—",
          variant: r.variant_title ?? "—",
        }));
      },
      table_threshold: 8,
      table_columns: ["store_id", "sku", "title", "variant"],
      table_column_labels: {
        store_id: "Store",
        sku: "SKU",
        title: "Product",
        variant: "Variant",
      },
    },
  ],

  fallback_suggestions: [
    "what's the average COGS per order?",
    "which day had the highest COGS?",
    "show me products missing COGS",
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

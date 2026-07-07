// Tools the CFO Agent can call. Phase 1 is strictly read-only — no writes
// or destructive operations. Every tool:
//   1. Accepts only validated input shapes (Zod).
//   2. Is scoped to the caller's tenantId — the model can't pass a different
//      tenant in even if it tried.
//   3. Returns a small JSON object (≤ ~2 KB) the model can reason about.
//
// Editing tools land in a separate file in Phase 2, guarded by a confirm-
// first flow + chat_audit_log writes.

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { loadStores, loadBlendedDashboardData } from "@/lib/pnl/queries";
import {
  loadLatestPortfolioSnapshot,
  loadPhxDailyRows,
} from "@/lib/phx/queries";
import { supabaseAdmin } from "@/lib/supabase/admin";

// ─── Schemas ──────────────────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const rangeInput = z
  .object({
    from: dateString.optional(),
    to: dateString.optional(),
    days: z.number().int().positive().max(365).optional(),
  })
  .refine(
    (v) => v.days != null || (v.from != null && v.to != null),
    "provide either { days } or { from, to }",
  );

const storeIdInput = z.string().min(1).max(32);

// ─── Tool definitions (Anthropic format) ──────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_stores",
    description:
      "List every store configured for the current tenant, with its currency, timezone, and processing-fee percentage. Use this when the user asks which stores exist or when you need a canonical store id list.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_dashboard_summary",
    description:
      "Get blended dashboard totals for a date range — total revenue, ad spend, net profit, ROAS, margin, orders, subs billed. Source of truth for 'how is the business doing?' questions. Defaults to last 7 days when no range is given.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description:
            "Rolling window ending today (e.g. 7, 30, 90). Use this OR (from + to).",
          minimum: 1,
          maximum: 365,
        },
        from: {
          type: "string",
          description: "Start date YYYY-MM-DD (inclusive).",
        },
        to: {
          type: "string",
          description: "End date YYYY-MM-DD (inclusive).",
        },
      },
    },
  },
  {
    name: "get_pnl_for_store",
    description:
      "Get per-day P&L (revenue, COGS, fees, refunds, ad spend, net profit) for a specific store and date range. Use when the user asks about a single store's numbers in detail.",
    input_schema: {
      type: "object",
      properties: {
        store_id: {
          type: "string",
          description:
            "Store id like NOVA, NURA, KOVA, LARA, SOLON, VOLE. Case-insensitive.",
        },
        days: { type: "integer", minimum: 1, maximum: 365 },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["store_id"],
    },
  },
  {
    name: "get_subscription_metrics",
    description:
      "Get latest subscription engine snapshot — active subscribers, cancelled subscribers, last scrape time. Use for 'how many subscribers?' or 'MRR?' style questions.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_phx_revenue_breakdown",
    description:
      "Get PHX/Solvpath revenue split by bucket (direct, initial, recurring, salvage, upsell) per store for a date range. Use when the user wants to understand where subscription dollars are coming from.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 365 },
        from: { type: "string" },
        to: { type: "string" },
        store_id: {
          type: "string",
          description: "Optional. Limit to a single PHX store (NOVA/NURA/KOVA).",
        },
      },
    },
  },
  {
    name: "get_ad_spend_entries",
    description:
      "Look up recent ad spend entries (manual log) for a store + date range. Returns the raw rows so you can show what was logged when, and by whom.",
    input_schema: {
      type: "object",
      properties: {
        store_id: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90 },
        from: { type: "string" },
        to: { type: "string" },
      },
    },
  },
  {
    name: "get_cogs_entries",
    description:
      "Look up recent COGS entries (manual log) for a store + date range.",
    input_schema: {
      type: "object",
      properties: {
        store_id: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 90 },
        from: { type: "string" },
        to: { type: "string" },
      },
    },
  },
  {
    name: "get_chargebacks_summary",
    description:
      "Get chargeback alerts summary by status (pending / won / lost / refunded) for the tenant in a date range.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 365 },
        from: { type: "string" },
        to: { type: "string" },
      },
    },
  },
];

// ─── Execution ────────────────────────────────────────────────────────────

export type ToolContext = {
  tenantId: string;
};

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_stores":
        return ok(await listStores(ctx));
      case "get_dashboard_summary":
        return ok(await getDashboardSummary(rangeInput.parse(rawInput ?? {}), ctx));
      case "get_pnl_for_store":
        return ok(
          await getPnlForStore(
            z
              .object({
                store_id: storeIdInput,
                days: z.number().int().positive().max(365).optional(),
                from: dateString.optional(),
                to: dateString.optional(),
              })
              .parse(rawInput),
            ctx,
          ),
        );
      case "get_subscription_metrics":
        return ok(await getSubscriptionMetrics(ctx));
      case "get_phx_revenue_breakdown":
        return ok(
          await getPhxRevenueBreakdown(
            z
              .object({
                days: z.number().int().positive().max(365).optional(),
                from: dateString.optional(),
                to: dateString.optional(),
                store_id: storeIdInput.optional(),
              })
              .parse(rawInput ?? {}),
            ctx,
          ),
        );
      case "get_ad_spend_entries":
        return ok(
          await getAdSpendEntries(
            z
              .object({
                store_id: storeIdInput.optional(),
                days: z.number().int().positive().max(90).optional(),
                from: dateString.optional(),
                to: dateString.optional(),
              })
              .parse(rawInput ?? {}),
            ctx,
          ),
        );
      case "get_cogs_entries":
        return ok(
          await getCogsEntries(
            z
              .object({
                store_id: storeIdInput.optional(),
                days: z.number().int().positive().max(90).optional(),
                from: dateString.optional(),
                to: dateString.optional(),
              })
              .parse(rawInput ?? {}),
            ctx,
          ),
        );
      case "get_chargebacks_summary":
        return ok(
          await getChargebacksSummary(
            z
              .object({
                days: z.number().int().positive().max(365).optional(),
                from: dateString.optional(),
                to: dateString.optional(),
              })
              .parse(rawInput ?? {}),
            ctx,
          ),
        );
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

// ─── Tool implementations ─────────────────────────────────────────────────

async function listStores(ctx: ToolContext) {
  const stores = await loadStores(ctx.tenantId);
  return {
    stores: stores
      .filter((s) => s.id !== "PORTFOLIO")
      .map((s) => ({
        id: s.id,
        name: s.name,
        currency: s.currency,
        timezone: s.timezone,
        processing_fee_pct: s.processing_fee_pct,
        is_phx_subscription: ["NOVA", "NURA", "KOVA"].includes(s.id),
      })),
  };
}

async function getDashboardSummary(
  range: { days?: number; from?: string; to?: string },
  ctx: ToolContext,
) {
  const spec = resolveRange(range);
  // Use the SAME blended source as the main /dashboard page so the numbers
  // the agent reports match exactly what the owner sees. (The earlier
  // loadPnlLedger path was drop-ship-only — it dropped NOVA/NURA/KOVA's
  // Shopify revenue and reported $0 for subscription-heavy tenants.)
  const data = await loadBlendedDashboardData(ctx.tenantId, spec);
  const t = data.periodTotals;
  const orders = t.shopify_orders + t.phx_subs_billed;
  return {
    range: data.range,
    totals: {
      revenue: round(t.shopify_revenue + t.phx_frontend_revenue),
      subs_revenue: round(t.phx_subs_revenue),
      total_revenue: round(t.total_revenue),
      cogs: round(t.shopify_cogs),
      refunds: round(t.shopify_refunds),
      ad_spend: round(t.shopify_ad_spend),
      net_profit: round(t.total_net_profit),
      orders,
      shopify_orders: t.shopify_orders,
      subs_billed: t.phx_subs_billed,
      roas: round(t.roas, 2),
      margin_pct: round(t.margin_pct, 1),
      source_mix: data.sourceMix,
    },
    note:
      "Blended totals — identical to the main dashboard. 'revenue' = Shopify front-end + PHX upsell. 'subs_revenue' = billed subscription revenue (Phoenix Initial+Recurring+Salvage plus Paysight rebills). 'total_revenue' = revenue + subs_revenue.",
  };
}

async function getPnlForStore(
  args: { store_id: string; days?: number; from?: string; to?: string },
  ctx: ToolContext,
) {
  const spec = resolveRange(args);
  const storeId = args.store_id.toUpperCase();
  // Validate the store exists for this tenant so an unknown id returns a clear
  // message ("no such store, here are the valid ones") instead of a silent
  // page of zeros that reads as a real-but-empty store.
  const stores = await loadStores(ctx.tenantId);
  const known = stores.filter((s) => s.id !== "PORTFOLIO").map((s) => s.id);
  if (!known.includes(storeId)) {
    return {
      error: `Unknown store "${storeId}".`,
      valid_stores: known,
      hint: "Call list_stores to see every store id for this account.",
    };
  }
  // Use the blended source scoped to this one store so PHX subscription stores
  // (NOVA/NURA/KOVA) report their real revenue. The old loadPnlLedger path was
  // drop-ship-only and returned all-zeros for PHX stores.
  const data = await loadBlendedDashboardData(ctx.tenantId, spec, {
    storeIds: [storeId],
  });
  const rows = data.daily
    .slice()
    .reverse() // newest first
    .slice(0, 60)
    .map((r) => {
      const revenue = r.shopify_revenue + r.phx_frontend_revenue;
      return {
        date: r.date,
        revenue: round(revenue),
        subs_revenue: round(r.phx_subs_revenue),
        total_revenue: round(r.total_revenue),
        cogs: round(r.shopify_cogs),
        refunds: round(r.shopify_refunds),
        ad_spend: round(r.shopify_ad_spend),
        net_profit: round(r.total_net_profit),
        orders: r.shopify_orders,
        subs_billed: r.phx_subs_billed,
      };
    });
  const t = data.periodTotals;
  return {
    store_id: storeId,
    rows,
    totals: {
      revenue: round(t.shopify_revenue + t.phx_frontend_revenue),
      subs_revenue: round(t.phx_subs_revenue),
      total_revenue: round(t.total_revenue),
      cogs: round(t.shopify_cogs),
      refunds: round(t.shopify_refunds),
      ad_spend: round(t.shopify_ad_spend),
      net_profit: round(t.total_net_profit),
      orders: t.shopify_orders,
      subs_billed: t.phx_subs_billed,
      roas: round(t.roas, 2),
      margin_pct: round(t.margin_pct, 1),
    },
  };
}

async function getSubscriptionMetrics(ctx: ToolContext) {
  const snap = await loadLatestPortfolioSnapshot(ctx.tenantId);
  if (!snap) {
    return { available: false, note: "No PORTFOLIO snapshot found yet." };
  }
  return {
    available: true,
    active_subscribers: snap.active_subscribers,
    cancelled_subscribers: snap.cancelled_subscribers,
    subscribers_in_salvage: snap.subscribers_in_salvage,
    range_from: snap.range_from,
    range_to: snap.range_to,
    scraped_at: snap.scraped_at,
  };
}

async function getPhxRevenueBreakdown(
  args: { days?: number; from?: string; to?: string; store_id?: string },
  ctx: ToolContext,
) {
  const spec = resolveRange(args);
  const storeIds = args.store_id
    ? [args.store_id.toUpperCase()]
    : ["NOVA", "NURA", "KOVA"];
  const rows = await loadPhxDailyRows(spec.from, spec.to, storeIds, ctx.tenantId);

  const byStore = new Map<
    string,
    {
      direct: number;
      initial: number;
      recurring: number;
      salvage: number;
      upsell: number;
      total: number;
      days: number;
    }
  >();
  for (const r of rows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const k = r.store_id;
    const cur = byStore.get(k) ?? {
      direct: 0,
      initial: 0,
      recurring: 0,
      salvage: 0,
      upsell: 0,
      total: 0,
      days: 0,
    };
    cur.direct += Number(r.revenue_direct ?? 0);
    cur.initial += Number(r.revenue_initial ?? 0);
    cur.recurring += Number(r.revenue_recurring ?? 0);
    cur.salvage += Number(r.revenue_salvage ?? 0);
    cur.upsell += Number(r.revenue_upsell ?? 0);
    cur.total += Number(r.revenue_total ?? 0);
    cur.days += 1;
    byStore.set(k, cur);
  }

  return {
    range: spec,
    per_store: Array.from(byStore.entries()).map(([store, agg]) => ({
      store_id: store,
      direct: round(agg.direct),
      initial: round(agg.initial),
      recurring: round(agg.recurring),
      salvage: round(agg.salvage),
      upsell: round(agg.upsell),
      total: round(agg.total),
      days_with_data: agg.days,
    })),
  };
}

async function getAdSpendEntries(
  args: { store_id?: string; days?: number; from?: string; to?: string },
  ctx: ToolContext,
) {
  const spec = resolveRange({ ...args, days: args.days ?? 14 });
  const sb = supabaseAdmin();
  let q = sb
    .from("ad_spend_entries")
    .select("id, store_id, date, amount, submitted_by, submitted_at")
    .eq("tenant_id", ctx.tenantId)
    .gte("date", spec.from)
    .lte("date", spec.to)
    .order("date", { ascending: false })
    .limit(50);
  if (args.store_id) q = q.eq("store_id", args.store_id.toUpperCase());
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { range: spec, entries: data ?? [] };
}

async function getCogsEntries(
  args: { store_id?: string; days?: number; from?: string; to?: string },
  ctx: ToolContext,
) {
  const spec = resolveRange({ ...args, days: args.days ?? 14 });
  const sb = supabaseAdmin();
  let q = sb
    .from("cogs_entries")
    .select("id, store_id, date, cogs, submitted_by, submitted_at")
    .eq("tenant_id", ctx.tenantId)
    .gte("date", spec.from)
    .lte("date", spec.to)
    .order("date", { ascending: false })
    .limit(50);
  if (args.store_id) q = q.eq("store_id", args.store_id.toUpperCase());
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { range: spec, entries: data ?? [] };
}

async function getChargebacksSummary(
  args: { days?: number; from?: string; to?: string },
  ctx: ToolContext,
) {
  const spec = resolveRange({ ...args, days: args.days ?? 30 });
  const sb = supabaseAdmin();
  const fromTs = `${spec.from}T00:00:00Z`;
  const toTs = `${spec.to}T23:59:59Z`;
  const { data, error } = await sb
    .from("chargeblast_alerts")
    .select("status, store_id, amount, currency, chargeblast_created_at")
    .eq("tenant_id", ctx.tenantId)
    .gte("chargeblast_created_at", fromTs)
    .lte("chargeblast_created_at", toTs);
  if (error) throw new Error(error.message);

  type Row = {
    status: string | null;
    store_id: string | null;
    amount: number | null;
    chargeblast_created_at: string;
  };
  const rows = (data ?? []) as Row[];
  const byStatus: Record<string, { count: number; total_amount: number }> = {};
  for (const r of rows) {
    const s = r.status ?? "unknown";
    const cur = byStatus[s] ?? { count: 0, total_amount: 0 };
    cur.count += 1;
    cur.total_amount += Number(r.amount ?? 0);
    byStatus[s] = cur;
  }
  return {
    range: spec,
    total_count: rows.length,
    by_status: Object.entries(byStatus).map(([status, agg]) => ({
      status,
      count: agg.count,
      total_amount: round(agg.total_amount),
    })),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function resolveRange(input: {
  days?: number;
  from?: string;
  to?: string;
}): { from: string; to: string; days: number } {
  if (input.from && input.to) {
    const from = input.from;
    const to = input.to;
    return { from, to, days: diffDays(from, to) + 1 };
  }
  const days = input.days ?? 7;
  const to = todayUtc();
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

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

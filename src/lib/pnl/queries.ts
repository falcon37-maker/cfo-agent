// Read-side queries for the dashboard and P&L pages.
// Aggregation is done in JS rather than SQL — 3 stores × ~180 days is small
// enough that a single `select … where date >= …` beats adding views/RPCs.

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  loadPhxDailyRows,
  type PhxSnapshot,
} from "@/lib/phx/queries";
import {
  loadPaysightSubsByDate,
  loadPaysightFrontendOrdersByDate,
} from "@/lib/paysight/queries";

// Stores for which PHX/Solvpath is the source of truth for revenue, and the
// processing-fee rates that apply to each kind of store. Both live in
// @/lib/pnl/fees so the dashboard, Subscriptions, Finance and Stores pages
// can't drift apart. For any store outside PHX_STORE_IDS, Shopify's daily_pnl
// stays the revenue source (future stores that only use Shopify Payments land
// there by default).
//
// Per client spec (Jun 2026 meeting): the Stores page shows ONLY the Shopify
// drop-shipping stores. NOVA/NURA/KOVA are subscription stores and live on the
// Subscriptions page, so they're excluded from the Stores ledger.
import {
  SUBSCRIPTION_STORE_IDS as PHX_STORE_IDS,
  SUBS_FEE_RATE,
  DROPSHIP_FEE_RATE,
} from "@/lib/pnl/fees";

export type StoreInfo = {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  shop_domain: string;
  processing_fee_pct: number;
};

export type DailyRow = {
  date: string; // YYYY-MM-DD
  revenue: number; // Shopify front-end
  subs_revenue: number; // PHX Initial + Recurring + Salvage (blended in for PHX stores)
  total_revenue: number; // revenue + subs_revenue
  cogs: number;
  fees: number;
  refunds: number;
  ad_spend: number;
  gross_profit: number;
  net_profit: number;
  margin_pct: number;
  // Shopify storefront orders only (matches what `shopify_orders` table
  // returns + what the expand panel shows). PHX subscription rebills are
  // counted separately so the parent row and expand panel agree.
  order_count: number;
  // PHX subscription billing events (initial + recurring + salvage +
  // upsell) for the same date. These don't have individual rows in the
  // expand panel because they happen outside Shopify, but they're tracked
  // so the dashboard can surface "+27 subs" alongside the Shopify count.
  phx_order_count: number;
};

export type Totals = {
  revenue: number;
  subs_revenue: number;
  total_revenue: number;
  cogs: number;
  fees: number;
  refunds: number;
  ad_spend: number;
  gross_profit: number;
  net_profit: number;
  orders: number;
  roas: number;
  margin_pct: number;
};

export type PerStorePoint = {
  store: string;
  revenue: number;
  ad_spend: number;
  net_profit: number;
  orders: number;
};

export type DashboardData = {
  stores: StoreInfo[];
  today: string;
  todayTotals: Totals;
  yesterdayTotals: Totals;
  kpiSparks: {
    revenue: number[];
    ad_spend: number[];
    roas: number[];
    net_profit: number[];
  };
  series30: DailyRow[]; // aggregated across all stores (DEPRECATED — use series)
  last10: DailyRow[]; // aggregated across all stores (DEPRECATED — use tableRows)
  storeMixToday: PerStorePoint[]; // DEPRECATED — use storeMix

  /** The range this dashboard reflects (from/to inclusive, `days` inclusive). */
  range: { from: string; to: string; days: number };

  /** Totals across the range. */
  periodTotals: Totals;

  /** Totals across the same-size period immediately prior to `range`. null if not enough history. */
  priorPeriodTotals: Totals | null;

  /** Oldest → newest daily series over the range. */
  series: DailyRow[];

  /** Newest → oldest, capped to 30 rows for the dashboard P&L table. */
  tableRows: DailyRow[];

  /** Per-store revenue / ad / profit over the range. */
  storeMix: PerStorePoint[];
};

export async function loadStores(tenantId: string): Promise<StoreInfo[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select(
      "id, name, currency, timezone, shop_domain, processing_fee_pct",
    )
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("id");
  if (error) throw new Error(`loadStores: ${error.message}`);
  return (data ?? []).map((s) => ({
    ...s,
    processing_fee_pct: Number(s.processing_fee_pct ?? 0),
  })) as StoreInfo[];
}

/** Per-store revenue totals for the window — feeds the dashboard donut.
 *  Uses daily_pnl.revenue (Shopify checkout), aggregated by store. */
export async function loadStoreRevenueBreakdown(
  tenantId: string,
  range: { days: number } | { from: string; to: string },
): Promise<Array<{ store: string; revenue: number }>> {
  const from =
    "from" in range ? range.from : addDays(todayUtc(), -(range.days - 1));
  const to = "from" in range ? range.to : todayUtc();
  const rows = await loadPnlRowsInRange(from, to, tenantId);
  const byStore = new Map<string, number>();
  for (const r of rows) {
    if (r.store_id === "PORTFOLIO" || r.store_id === "__BACKFILL_DEDUPE__") continue;
    byStore.set(r.store_id, (byStore.get(r.store_id) ?? 0) + Number(r.revenue ?? 0));
  }
  return [...byStore.entries()]
    .map(([store, revenue]) => ({ store, revenue: Math.round(revenue * 100) / 100 }))
    .filter((s) => s.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
}

/** Fetch raw daily_pnl rows (one per store-day) in the inclusive [from, to] window. */
async function loadPnlRowsInRange(
  from: string,
  to: string,
  tenantId: string,
): Promise<RawPnlRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("daily_pnl")
    .select(
      "store_id, date, revenue, cogs, fees, refunds, ad_spend, gross_profit, net_profit, margin_pct, order_count",
    )
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: false });
  if (error) throw new Error(`loadPnlRowsInRange: ${error.message}`);
  return (data ?? []) as RawPnlRow[];
}

/** Convenience: last `days` days ending today (UTC). */
async function loadPnlRows(
  days: number,
  tenantId: string,
): Promise<RawPnlRow[]> {
  const to = todayUtc();
  const from = addDays(to, -(days - 1));
  return loadPnlRowsInRange(from, to, tenantId);
}

type RawPnlRow = {
  store_id: string;
  date: string;
  revenue: number | string;
  cogs: number | string;
  fees: number | string;
  refunds: number | string;
  ad_spend: number | string;
  gross_profit: number | string;
  net_profit: number | string;
  margin_pct: number | string | null;
  order_count: number;
};

export async function loadDashboardData(
  tenantId: string,
  rangeSpec?: { days: number } | { from: string; to: string },
): Promise<DashboardData> {
  const stores = await loadStores(tenantId);

  // Resolve range.
  const today = todayUtc();
  let from: string;
  let to: string;
  if (rangeSpec && "from" in rangeSpec) {
    from = rangeSpec.from;
    to = rangeSpec.to;
  } else {
    const days = rangeSpec?.days ?? 30;
    to = today;
    from = addDays(to, -(days - 1));
  }
  const days = Math.max(1, diffDays(from, to) + 1);

  // Pull current range + the same-size prior period (for deltas) in one query.
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(days - 1));
  const allRows = await loadPnlRowsInRange(priorFrom, to, tenantId);
  const curRows = allRows.filter((r) => r.date >= from && r.date <= to);
  const priorRows = allRows.filter(
    (r) => r.date >= priorFrom && r.date <= priorTo,
  );

  const byDateCur = groupByDate(curRows);
  const seriesDates = Object.keys(byDateCur).sort(); // oldest → newest
  const series: DailyRow[] = seriesDates.map((d) => aggregate(byDateCur[d]));
  const tableRows: DailyRow[] = [...series].reverse().slice(0, 30);

  // Totals across the range + prior range.
  const periodTotals = sumTotals(series);
  const priorSeries = Object.keys(groupByDate(priorRows))
    .sort()
    .map((d) => aggregate(groupByDate(priorRows)[d]));
  const priorPeriodTotals =
    priorSeries.length > 0 ? sumTotals(priorSeries) : null;

  // KPI sparks from the current range.
  const kpiSparks = {
    revenue: series.map((r) => r.revenue),
    ad_spend: series.map((r) => r.ad_spend),
    roas: series.map((r) => (r.ad_spend > 0 ? r.revenue / r.ad_spend : 0)),
    net_profit: series.map((r) => r.net_profit),
  };

  // Store mix: sum per-store metrics over the range.
  const storeMix: PerStorePoint[] = stores.map((s) => {
    const rows = curRows.filter((r) => r.store_id === s.id);
    const rev = rows.reduce((sum, r) => sum + num(r.revenue), 0);
    const ad = rows.reduce((sum, r) => sum + num(r.ad_spend), 0);
    const profit = rows.reduce((sum, r) => sum + num(r.net_profit), 0);
    const orders = rows.reduce((sum, r) => sum + (r.order_count ?? 0), 0);
    return {
      store: s.id,
      revenue: rev,
      ad_spend: ad,
      net_profit: profit,
      orders,
    };
  });

  // Legacy fields kept for any lingering callers.
  const todayAgg = byDateCur[today]
    ? aggregate(byDateCur[today])
    : emptyDailyRow(today);
  const ydayKey = addDays(today, -1);
  const ydayAgg = byDateCur[ydayKey]
    ? aggregate(byDateCur[ydayKey])
    : emptyDailyRow(ydayKey);

  return {
    stores,
    today,
    todayTotals: toTotals(todayAgg),
    yesterdayTotals: toTotals(ydayAgg),
    kpiSparks,
    series30: series,
    last10: tableRows.slice(0, 10),
    storeMixToday: storeMix,

    range: { from, to, days },
    periodTotals,
    priorPeriodTotals,
    series,
    tableRows,
    storeMix,
  };
}

// ═══ Blended (Shopify + PHX recurring) dashboard ═══════════════════════════
// Shopify sees front-end orders (direct + initial subscription). PHX sees
// those same orders AND the automated rebills that never hit Shopify. To
// avoid double-counting, "PHX revenue" on this dashboard is strictly
// recurring + salvage — the pieces Shopify doesn't know about.

export type BlendedDailyRow = {
  date: string;
  shopify_revenue: number; // non-PHX stores only
  shopify_ad_spend: number;
  shopify_net_profit: number;
  shopify_orders: number; // = new_subs + upsell_orders (total frontend orders)
  new_subs: number; // distinct customers (de-duped) — the clean CPA denominator
  upsell_orders: number; // extra same-customer orders (upsell add-ons)
  shopify_cogs: number;
  shopify_refunds: number;
  phx_revenue: number; // PHX total (frontend + subs + upsell), per-day actual
  phx_net_contribution: number; // phx_revenue × (1 − fee_rate)
  phx_subs_billed: number; // count of initial + recurring + salvage tx on this day
  // Per-day actuals from PHX (no amortization), broken out for the table:
  phx_frontend_revenue: number; // Direct only
  phx_subs_revenue: number; // Initial + Recurring + Salvage (Initial is PHX-only)
  phx_upsell_revenue: number;
  /** Sum of manual_revenue_entries.amount for this day. Coaching, consulting,
   *  one-off sales — anything not covered by an API integration. */
  manual_revenue: number;
  total_revenue: number;
  total_net_profit: number;
};

export type BlendedTotals = {
  shopify_revenue: number;
  shopify_ad_spend: number;
  shopify_net_profit: number;
  shopify_orders: number;
  new_subs: number;
  upsell_orders: number;
  shopify_cogs: number;
  shopify_refunds: number;
  phx_revenue: number;
  phx_net_contribution: number;
  phx_frontend_revenue: number;
  phx_subs_revenue: number;
  phx_upsell_revenue: number;
  phx_subs_billed: number;
  manual_revenue: number;
  total_revenue: number;
  total_net_profit: number;
  roas: number; // total_revenue / shopify_ad_spend
  margin_pct: number; // total_net_profit / total_revenue × 100
};

export type BlendedDashboardData = {
  range: { from: string; to: string; days: number };
  feeRate: number;
  daily: BlendedDailyRow[]; // oldest → newest
  tableRows: BlendedDailyRow[]; // newest → oldest, capped to 30
  periodTotals: BlendedTotals;
  priorPeriodTotals: BlendedTotals | null;
  sourceMix: {
    shopify: number;
    phx: number;
  };
  kpiSparks: {
    revenue: number[];
    ad_spend: number[];
    roas: number[];
    net_profit: number[];
  };
  phxSnapshotsUsed: number; // how many PHX snapshots overlapped the range
};

type PhxDayJson = {
  recurringCount?: number;
  salvageCount?: number;
  directCount?: number;
  initialCount?: number;
  upsellCount?: number;
};

type PhxDayTotals = {
  /** PHX Direct Sale only — one-time non-subscription orders. */
  frontend: number;
  /** PHX Initial + Recurring + Salvage. Initial transactions are PHX-only
   *  (they don't flow through Shopify checkout), so including them here
   *  doesn't double-count anything. */
  subs: number;
  upsell: number;
  total: number;
  /** initialCount + recurringCount + salvageCount. */
  subsBilledCount: number;
};

/**
 * Roll up per-day per-store snapshot rows into Map<date, totals> aggregated
 * across all PHX stores. No amortization — each row already represents one
 * store's actual transactions on one day.
 */
function rollupPhxByDay(rows: PhxSnapshot[]): Map<string, PhxDayTotals> {
  const out = new Map<string, PhxDayTotals>();
  for (const r of rows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const date = r.range_from;
    const direct = Number(r.revenue_direct ?? 0);
    const initial = Number(r.revenue_initial ?? 0);
    const recurring = Number(r.revenue_recurring ?? 0);
    const salvage = Number(r.revenue_salvage ?? 0);
    const upsell = Number(r.revenue_upsell ?? 0);
    const json = (r.raw_json as PhxDayJson | null) ?? {};
    const initialCount = Number(json.initialCount ?? 0);
    const recurringCount = Number(json.recurringCount ?? 0);
    const salvageCount = Number(json.salvageCount ?? 0);

    const cur = out.get(date) ?? {
      frontend: 0,
      subs: 0,
      upsell: 0,
      total: 0,
      subsBilledCount: 0,
    };
    // Direct = one-time non-subscription. Subs = Initial + Recurring +
    // Salvage. Initial doesn't flow through Shopify checkout — it's PHX-
    // only — so counting it as Subs Rev doesn't double-count Shopify.
    cur.frontend += direct;
    cur.subs += initial + recurring + salvage;
    cur.upsell += upsell;
    cur.total += direct + initial + recurring + salvage + upsell;
    cur.subsBilledCount += initialCount + recurringCount + salvageCount;
    out.set(date, cur);
  }
  return out;
}

export async function loadBlendedDashboardData(
  tenantId: string,
  rangeSpec?: { days: number } | { from: string; to: string },
  opts?: { storeScope?: "all" | "subscription"; storeIds?: string[] },
): Promise<BlendedDashboardData> {
  // "subscription" scope = only the subscription stores (NOVA/NURA/KOVA), so
  // the Subscriptions page can reuse the full blended table (with ad spend,
  // ROAS, etc.) but show those stores only. Client spec Jun 2026.
  const subsOnly = opts?.storeScope === "subscription";
  // Optional store filter (e.g. the Subscriptions page's KOVA/NOVA/NURA chips).
  // When set, every part of the blend is restricted to these stores.
  const storeFilter =
    opts?.storeIds && opts.storeIds.length
      ? new Set(opts.storeIds.map((s) => s.toUpperCase()))
      : null;
  const inScope = (storeId: string) => {
    if (subsOnly && !PHX_STORE_IDS.has(storeId)) return false;
    if (storeFilter && !storeFilter.has(storeId.toUpperCase())) return false;
    return true;
  };
  const stores = await loadStores(tenantId);
  // Subscription revenue always bills through the ~16.3% processor (client spec
  // Jun 2026), in EVERY scope. This used to read
  // `stores.find(s => s.id !== "PORTFOLIO").processing_fee_pct` — i.e. whichever
  // store sorted first (a drop-ship store at 2.7%) — and charged that rate on
  // subscription revenue, which is why the dashboard reported a higher Net
  // Profit than the Subscriptions page for the same day.
  const feeRate = SUBS_FEE_RATE;

  // Resolve range.
  const today = todayUtc();
  let from: string;
  let to: string;
  if (rangeSpec && "from" in rangeSpec) {
    from = rangeSpec.from;
    to = rangeSpec.to;
  } else {
    const d = rangeSpec?.days ?? 30;
    to = today;
    from = addDays(to, -(d - 1));
  }
  const days = Math.max(1, diffDays(from, to) + 1);

  // Pull current + prior range's Shopify rows in one query.
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(days - 1));
  const allPnlRaw = await loadPnlRowsInRange(priorFrom, to, tenantId);
  // Restrict the Shopify rows to the in-scope stores (subscription scope and/or
  // an explicit store filter), so orders/revenue/ad spend/ROAS reflect them.
  const allPnl =
    subsOnly || storeFilter
      ? allPnlRaw.filter((r) => inScope(r.store_id))
      : allPnlRaw;
  const curPnl = allPnl.filter((r) => r.date >= from && r.date <= to);
  const priorPnl = allPnl.filter(
    (r) => r.date >= priorFrom && r.date <= priorTo,
  );

  // Per-day per-store PHX rows for both windows. No amortization — each row
  // already represents one store's actual transactions on one day.
  const phxStoreIds = stores
    .map((s) => s.id)
    .filter((id) => PHX_STORE_IDS.has(id) && inScope(id));
  const phxCur = await loadPhxDailyRows(from, to, phxStoreIds, tenantId);
  const phxPrior = await loadPhxDailyRows(priorFrom, priorTo, phxStoreIds, tenantId);
  const phxByDayCur = rollupPhxByDay(phxCur);
  const phxByDayPrior = rollupPhxByDay(phxPrior);

  // Paysight BILLED subscription revenue per day (rebills only — the loader
  // filters payment_number >= 1). ADDED to Phoenix billed revenue: each
  // rebill happens on exactly one platform, so no double-count. Cycle-0
  // checkout charges are newly-acquired store revenue, not Subs Rev.
  const paysightCur = await loadPaysightSubsByDate(
    tenantId,
    from,
    to,
    phxStoreIds,
  );
  // Frontend (checkout) order count per day, counted PER CUSTOMER from the
  // Paysight gateway so upsells (a second charge on the same customer/order)
  // don't double-count. Client spec Jun 2026.
  const paysightFrontendCur = await loadPaysightFrontendOrdersByDate(
    tenantId,
    from,
    to,
    phxStoreIds,
  );
  const paysightPrior = await loadPaysightSubsByDate(
    tenantId,
    priorFrom,
    priorTo,
    phxStoreIds,
  );
  const paysightFrontendPrior = await loadPaysightFrontendOrdersByDate(
    tenantId,
    priorFrom,
    priorTo,
    phxStoreIds,
  );

  // Manual revenue entries (coaching / consulting / one-offs).
  const manualByDayCur = await loadManualRevenueByDay(tenantId, from, to);
  const manualByDayPrior = await loadManualRevenueByDay(
    tenantId,
    priorFrom,
    priorTo,
  );

  // Split Shopify rows: keep non-PHX-store rows as the revenue source;
  // PHX-store rows only contribute cogs/refunds/ad_spend/orders (revenue is
  // taken from PHX for those stores).
  const isPhxStore = (row: RawPnlRow) => PHX_STORE_IDS.has(row.store_id);
  const shopifyByDateNonPhx = groupByDate(curPnl.filter((r) => !isPhxStore(r)));
  const shopifyByDateAll = groupByDate(curPnl);
  const shopifyByDatePhx = groupByDate(curPnl.filter((r) => isPhxStore(r)));
  const shopifyByDatePriorNonPhx = groupByDate(
    priorPnl.filter((r) => !isPhxStore(r)),
  );
  const shopifyByDatePriorAll = groupByDate(priorPnl);
  const shopifyByDatePriorPhx = groupByDate(
    priorPnl.filter((r) => isPhxStore(r)),
  );

  const emptyPhxDay: PhxDayTotals = {
    frontend: 0,
    subs: 0,
    upsell: 0,
    total: 0,
    subsBilledCount: 0,
  };

  // Build the daily array for the current range (every day in [from..to]).
  const daily: BlendedDailyRow[] = [];
  let cur = from;
  while (cur <= to) {
    const nonPhxShop = aggregate(shopifyByDateNonPhx[cur] ?? []);
    const allShop = aggregate(shopifyByDateAll[cur] ?? []);
    const phxShop = aggregate(shopifyByDatePhx[cur] ?? []);
    const phx = phxByDayCur.get(cur) ?? emptyPhxDay;

    // Subs bucket = BILLED only: Phoenix billed + Paysight rebills (additive
    // — each charge is on exactly one platform). The loader already excludes
    // cycle-0 newly-acquired checkout charges.
    const pay = paysightCur.get(cur);
    const subs = phx.subs + (pay?.subs ?? 0);
    const subsBilled = phx.subsBilledCount + (pay?.subOrders ?? 0);

    // Frontend order count = non-PHX (drop-ship) Shopify orders + PHX
    // storefront orders. For PHX stores we prefer the Paysight gateway's
    // per-customer count (dedupes upsells — client spec Jun 2026), but BEFORE
    // the Paysight migration (~late May 2026) there are no Paysight rows, so
    // we fall back to the PHX stores' Shopify order count for those days.
    // PHX storefront orders from Paysight split into new subs (distinct
    // customers) + upsell (extra same-customer orders). Pre-migration days have
    // no Paysight rows → fall back to the PHX Shopify order count (all "new").
    const phxFront = paysightFrontendCur.get(cur);
    const phxNewSubs = phxFront ? phxFront.newSubs : phxShop.order_count;
    const phxUpsell = phxFront ? phxFront.upsell : 0;
    // "New Subs" = subscription-store acquisitions ONLY (PHX/Paysight distinct
    // customers). Client spec (Jun 2026): drop-ship Shopify orders are NOT new
    // subscribers, so they're excluded from this CPA/cost-per-sub denominator
    // (they still count in total revenue / order figures via shopify_revenue).
    const newSubs = phxNewSubs;
    const upsellOrders = phxUpsell;
    const frontendOrders = newSubs + upsellOrders;

    // Money story (mirrors /pnl, post-migration): store revenue = Shopify
    // checkout for ALL stores — PHX stores included, since that's where
    // newly-acquired dollars live now. The subscription platforms add their
    // BILLED revenue (+ legacy PHX upsell) on top. phxTotal is the
    // subscription-platform slice only.
    const phxTotal = subs + phx.upsell;

    // Processing fees are recomputed here from the client-spec rates rather
    // than taken from the stored daily_pnl.net_profit, which is computed with
    // each store's own `processing_fee_pct` (subscription stores sat at 10%,
    // drop-ship at 2.7–3.0%). Recomputing means every page nets out the same
    // fee the Fees column displays, so each row foots exactly:
    //   Total − COGS − Fees − Ad Spend = Net Profit.
    const nonPhxContribution =
      nonPhxShop.revenue -
      nonPhxShop.cogs -
      nonPhxShop.revenue * DROPSHIP_FEE_RATE -
      nonPhxShop.ad_spend;
    // PHX stores: 16.3% applies to their Shopify checkout AND to their billed
    // subscription revenue (client spec Jun 2026). Their contribution = own
    // Shopify net + the billed subscription dollars net of the same fee.
    const phxShopNet =
      phxShop.revenue -
      phxShop.cogs -
      phxShop.revenue * SUBS_FEE_RATE -
      phxShop.ad_spend;
    const phxContribution = phxTotal * (1 - feeRate) + phxShopNet;
    const manual = manualByDayCur.get(cur) ?? 0;
    daily.push({
      date: cur,
      shopify_revenue: round2(nonPhxShop.revenue),
      shopify_ad_spend: round2(allShop.ad_spend),
      shopify_net_profit: round2(nonPhxContribution),
      shopify_cogs: round2(allShop.cogs),
      shopify_refunds: round2(allShop.refunds),
      phx_revenue: round2(phxTotal),
      phx_net_contribution: round2(phxContribution),
      phx_subs_billed: subsBilled,
      shopify_orders: frontendOrders,
      new_subs: newSubs,
      upsell_orders: upsellOrders,
      // Frontend = Shopify checkout revenue for PHX stores (one-time +
      // newly-acquired subscription enrollments — both ring up at checkout).
      phx_frontend_revenue: round2(phxShop.revenue),
      phx_subs_revenue: round2(subs),
      phx_upsell_revenue: round2(phx.upsell),
      manual_revenue: round2(manual),
      // Total = every store's Shopify checkout + billed subscription revenue
      // (+ legacy PHX upsell) + manual — same shape as the /pnl ledger.
      total_revenue: round2(allShop.revenue + phxTotal + manual),
      // Net profit — ONE formula for every scope. The Dashboard and the
      // Subscriptions page used to branch here (`subsOnly ? … : …`) and charge
      // different fee rates on the same day, so the two pages disagreed by
      // 15–20%. Manual revenue is added whole: it's coaching/consulting, not
      // card-processed, so no processor fee and no COGS apply to it.
      total_net_profit: round2(
        nonPhxContribution + phxContribution + manual,
      ),
    });
    cur = addDays(cur, 1);
  }

  // Same shape for prior window (only used to sum totals for deltas).
  const priorDaily: BlendedDailyRow[] = [];
  let curP = priorFrom;
  while (curP <= priorTo) {
    const nonPhxShop = aggregate(shopifyByDatePriorNonPhx[curP] ?? []);
    const allShop = aggregate(shopifyByDatePriorAll[curP] ?? []);
    const phxShop = aggregate(shopifyByDatePriorPhx[curP] ?? []);
    const phx = phxByDayPrior.get(curP) ?? emptyPhxDay;
    const payP = paysightPrior.get(curP);
    const subsP = phx.subs + (payP?.subs ?? 0);
    const subsBilledP = phx.subsBilledCount + (payP?.subOrders ?? 0);
    const phxFrontP = paysightFrontendPrior.get(curP);
    const phxNewSubsP = phxFrontP ? phxFrontP.newSubs : phxShop.order_count;
    const phxUpsellP = phxFrontP ? phxFrontP.upsell : 0;
    // New Subs = subscription stores only (drop-ship excluded — see current loop).
    const newSubsP = phxNewSubsP;
    const upsellOrdersP = phxUpsellP;
    const frontendOrdersP = newSubsP + upsellOrdersP;
    // Same money story as the current loop: billed subs (+ upsell) on top of
    // every store's Shopify checkout net.
    const phxTotalP = subsP + phx.upsell;
    // Same recomputed fees as the current loop — see the comment there.
    const nonPhxContribution =
      nonPhxShop.revenue -
      nonPhxShop.cogs -
      nonPhxShop.revenue * DROPSHIP_FEE_RATE -
      nonPhxShop.ad_spend;
    const phxShopNet =
      phxShop.revenue -
      phxShop.cogs -
      phxShop.revenue * SUBS_FEE_RATE -
      phxShop.ad_spend;
    const phxContribution = phxTotalP * (1 - feeRate) + phxShopNet;
    const manualP = manualByDayPrior.get(curP) ?? 0;
    priorDaily.push({
      date: curP,
      shopify_revenue: round2(nonPhxShop.revenue),
      shopify_ad_spend: round2(allShop.ad_spend),
      shopify_net_profit: round2(nonPhxContribution),
      shopify_orders: frontendOrdersP,
      new_subs: newSubsP,
      upsell_orders: upsellOrdersP,
      shopify_cogs: round2(allShop.cogs),
      shopify_refunds: round2(allShop.refunds),
      phx_revenue: round2(phxTotalP),
      phx_net_contribution: round2(phxContribution),
      phx_subs_billed: subsBilledP,
      phx_frontend_revenue: round2(phxShop.revenue),
      phx_subs_revenue: round2(subsP),
      phx_upsell_revenue: round2(phx.upsell),
      manual_revenue: round2(manualP),
      total_revenue: round2(allShop.revenue + phxTotalP + manualP),
      total_net_profit: round2(
        nonPhxContribution + phxContribution + manualP,
      ),
    });
    curP = addDays(curP, 1);
  }

  const periodTotals = sumBlended(daily);
  const priorPeriodTotals =
    priorDaily.length > 0 && priorPnl.length + phxPrior.length > 0
      ? sumBlended(priorDaily)
      : null;

  const kpiSparks = {
    revenue: daily.map((r) => r.total_revenue),
    ad_spend: daily.map((r) => r.shopify_ad_spend),
    roas: daily.map((r) =>
      r.shopify_ad_spend > 0 ? r.total_revenue / r.shopify_ad_spend : 0,
    ),
    net_profit: daily.map((r) => r.total_net_profit),
  };

  const tableRows = [...daily].reverse().slice(0, 30);

  return {
    range: { from, to, days },
    feeRate,
    daily,
    tableRows,
    periodTotals,
    priorPeriodTotals,
    sourceMix: {
      shopify: periodTotals.shopify_revenue,
      phx: periodTotals.phx_revenue,
    },
    kpiSparks,
    phxSnapshotsUsed: phxCur.length,
  };
}

function sumBlended(rows: BlendedDailyRow[]): BlendedTotals {
  let shopify_revenue = 0,
    shopify_ad_spend = 0,
    shopify_net_profit = 0,
    shopify_orders = 0,
    new_subs = 0,
    upsell_orders = 0,
    shopify_cogs = 0,
    shopify_refunds = 0,
    phx_revenue = 0,
    phx_net_contribution = 0,
    phx_frontend_revenue = 0,
    phx_subs_revenue = 0,
    phx_upsell_revenue = 0,
    phx_subs_billed = 0,
    manual_revenue = 0;
  for (const r of rows) {
    shopify_revenue += r.shopify_revenue;
    shopify_ad_spend += r.shopify_ad_spend;
    shopify_net_profit += r.shopify_net_profit;
    shopify_orders += r.shopify_orders;
    new_subs += r.new_subs;
    upsell_orders += r.upsell_orders;
    shopify_cogs += r.shopify_cogs;
    shopify_refunds += r.shopify_refunds;
    phx_revenue += r.phx_revenue;
    phx_net_contribution += r.phx_net_contribution;
    phx_frontend_revenue += r.phx_frontend_revenue;
    phx_subs_revenue += r.phx_subs_revenue;
    phx_upsell_revenue += r.phx_upsell_revenue;
    phx_subs_billed += r.phx_subs_billed;
    manual_revenue += r.manual_revenue;
  }
  // Total = non-PHX Shopify + PHX-store Shopify checkout (phx_frontend_revenue)
  // + subscription-platform revenue (phx_revenue = billed subs + upsell) +
  // manual. Earlier this omitted phx_frontend_revenue, so PHX stores' Shopify
  // checkout dollars silently dropped out of Total Revenue (matched neither the
  // per-day row total nor the store donut). phx_net_contribution already
  // includes the PHX-store Shopify net, so net profit needs no extra term.
  const total_revenue =
    shopify_revenue + phx_frontend_revenue + phx_revenue + manual_revenue;
  const total_net_profit = shopify_net_profit + phx_net_contribution + manual_revenue;
  return {
    shopify_revenue: round2(shopify_revenue),
    shopify_ad_spend: round2(shopify_ad_spend),
    shopify_net_profit: round2(shopify_net_profit),
    shopify_orders,
    new_subs,
    upsell_orders,
    shopify_cogs: round2(shopify_cogs),
    shopify_refunds: round2(shopify_refunds),
    phx_revenue: round2(phx_revenue),
    phx_net_contribution: round2(phx_net_contribution),
    phx_frontend_revenue: round2(phx_frontend_revenue),
    phx_subs_revenue: round2(phx_subs_revenue),
    phx_upsell_revenue: round2(phx_upsell_revenue),
    phx_subs_billed,
    manual_revenue: round2(manual_revenue),
    total_revenue: round2(total_revenue),
    total_net_profit: round2(total_net_profit),
    roas: shopify_ad_spend > 0 ? total_revenue / shopify_ad_spend : 0,
    margin_pct: total_revenue > 0 ? (total_net_profit / total_revenue) * 100 : 0,
  };
}

/** Sum manual_revenue_entries by date for a tenant + window. */
async function loadManualRevenueByDay(
  tenantId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("manual_revenue_entries")
    .select("date, amount")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to);
  const out = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ date: string; amount: number | string }>) {
    out.set(r.date, (out.get(r.date) ?? 0) + Number(r.amount ?? 0));
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ═════════════════════════════════════════════════════════════════════════════

export type PnlLedger = {
  stores: StoreInfo[];
  rows: DailyRow[]; // newest first
  totals: Totals;
  days: number;
  /** Selected store IDs. Empty array = all stores. */
  selectedStores: string[];
};

/** Filtered/aggregated ledger for /pnl.
 *  Pass either `days` (rolling window ending today) or an explicit `{from, to}`.
 *  storeFilter may be a single id, "all", or an array of ids; an empty array
 *  is equivalent to "all".
 *
 *  For stores in PHX_STORE_IDS we also pull per-day Initial + Recurring +
 *  Salvage revenue from phx_summary_snapshots and blend it into each row's
 *  subs_revenue / total_revenue, so the Stores page shows the real picture
 *  for NOVA/NURA/KOVA — not just their Shopify front-end slice. */
export async function loadPnlLedger(
  rangeSpec: { days: number } | { from: string; to: string },
  storeFilter: string | string[],
  tenantId: string,
): Promise<PnlLedger> {
  // Stores page = drop-ship stores only (exclude PHX subscription stores).
  const stores = (await loadStores(tenantId)).filter(
    (s) => !PHX_STORE_IDS.has(s.id),
  );
  const allRows =
    "from" in rangeSpec
      ? await loadPnlRowsInRange(rangeSpec.from, rangeSpec.to, tenantId)
      : await loadPnlRows(rangeSpec.days, tenantId);
  // Drop any PHX-store rows so subscription stores never surface here.
  const rows = allRows.filter((r) => !PHX_STORE_IDS.has(r.store_id));

  const selected = normalizeStoreFilter(storeFilter).filter(
    (id) => !PHX_STORE_IDS.has(id),
  );
  const filtered =
    selected.length === 0
      ? rows
      : rows.filter((r) => selected.includes(r.store_id));

  // Fetch PHX subs revenue for any PHX stores in the selection (or all PHX
  // stores when no filter is applied).
  const phxStoreIds = stores
    .map((s) => s.id)
    .filter((id) => PHX_STORE_IDS.has(id));
  const phxStoresInFilter =
    selected.length === 0
      ? phxStoreIds
      : selected.filter((id) => PHX_STORE_IDS.has(id));

  // Resolve the date window we actually need.
  const winFrom =
    "from" in rangeSpec
      ? rangeSpec.from
      : addDays(todayUtc(), -(rangeSpec.days - 1));
  const winTo = "from" in rangeSpec ? rangeSpec.to : todayUtc();
  const phxRows = await loadPhxDailyRows(winFrom, winTo, phxStoresInFilter, tenantId);

  // Paysight BILLED subscription revenue per date (rebills, payment_number
  // >= 1) — same PHX-store filter. ADDED to Phoenix billed revenue: each
  // rebill is charged on exactly one platform (subs migrated Phoenix →
  // Paysight Jun 2026), so the two sources never overlap. Newly-acquired
  // cycle-0 checkout charges are store revenue, NOT Subs Rev (client spec
  // Jun 2026: "only what was billed that day from subs").
  const paysightByDate = await loadPaysightSubsByDate(
    tenantId,
    winFrom,
    winTo,
    phxStoresInFilter,
  );

  // Per-day PHX contribution split into two buckets:
  //   subs   = Initial + Recurring + Salvage  → goes into "subs revenue"
  //   upsell = revenue_upsell                 → goes into "frontend revenue"
  //
  // Why this split: client spec (May 2026 meeting) — upsell is an
  // at-checkout add-on rung up alongside the first Shopify purchase, so
  // it belongs with Direct/Frontend revenue, NOT with the subscription
  // cycle. The dashboard blender (BlendedPnlTable) already does this; we
  // mirror it here so the simpler /pnl and AI-tool numbers stay consistent.
  //
  // Initial / Recurring / Salvage are PHX-only — they don't flow through
  // Shopify checkout — so adding them on top of daily_pnl.revenue doesn't
  // double-count. PHX "Direct" is one-time non-subscription and is already
  // captured by Shopify, so it stays out of the subs bucket here.
  const phxByDate = new Map<
    string,
    { subs: number; upsell: number; subOrders: number; upsellOrders: number }
  >();
  for (const r of phxRows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const subs =
      Number(r.revenue_initial ?? 0) +
      Number(r.revenue_recurring ?? 0) +
      Number(r.revenue_salvage ?? 0);
    const upsell = Number(r.revenue_upsell ?? 0);
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    const subOrders =
      Number(j.initialCount ?? 0) +
      Number(j.recurringCount ?? 0) +
      Number(j.salvageCount ?? 0);
    const upsellOrders = Number(j.upsellCount ?? 0);
    // KEY NORMALIZATION (bug fix): daily_pnl.date comes back as a plain
    // 'YYYY-MM-DD' string, but phx range_from is a timestamptz and comes back
    // as a full ISO string ('...T19:00:00.000Z'). Keying phxByDate on the raw
    // range_from meant phxByDate.get(dailyDate) never matched → subs revenue
    // silently dropped to 0. Both represent the SAME store-local day, so
    // collapse range_from to the same YYYY-MM-DD the daily_pnl keys use.
    const dayKey = phxDayKey(r.range_from);
    const cur =
      phxByDate.get(dayKey) ??
      { subs: 0, upsell: 0, subOrders: 0, upsellOrders: 0 };
    cur.subs += subs;
    cur.upsell += upsell;
    cur.subOrders += subOrders;
    cur.upsellOrders += upsellOrders;
    phxByDate.set(dayKey, cur);
  }

  // Drop-ship stores all bill through the same ~3.9% processor (client spec).
  const feeRate = DROPSHIP_FEE_RATE;

  const byDate = groupByDate(filtered);
  const ordered = Object.keys(byDate).sort().reverse();
  const ledger: DailyRow[] = ordered.map((d) => {
    const raw = aggregate(byDate[d]);
    // Drop-ship stores: recompute fees at ~3.9% (client spec) instead of the
    // per-store DB rate, and re-derive net profit so the two stay consistent.
    const dropFees = raw.revenue * DROPSHIP_FEE_RATE;
    const base: DailyRow = {
      ...raw,
      fees: dropFees,
      net_profit: raw.revenue - raw.cogs - dropFees - raw.ad_spend,
      margin_pct:
        raw.revenue > 0
          ? ((raw.revenue - raw.cogs - dropFees - raw.ad_spend) / raw.revenue) *
            100
          : 0,
    };
    const phx = phxByDate.get(d);
    const pay = paysightByDate.get(d);

    // ── Subs Rev = BILLED only: Phoenix billed + Paysight rebills ──
    // Phoenix bills its legacy subscribers (Initial + Recurring + Salvage);
    // Paysight bills the migrated ones (rebills, payment_number >= 1 — the
    // loader already filters). Each charge happens on exactly one platform,
    // so the sources are additive with no double-count. Upsell stays a
    // Phoenix concept and rolls into frontend revenue.
    const subs = (phx?.subs ?? 0) + (pay?.subs ?? 0);
    const subOrders = (phx?.subOrders ?? 0) + (pay?.subOrders ?? 0);
    const upsell = phx?.upsell ?? 0;
    const upsellOrders = phx?.upsellOrders ?? 0;

    if (subs + upsell === 0) {
      return { ...base, phx_order_count: 0 };
    }

    // Subscription dollars add to revenue. Net profit picks up the
    // subscription revenue × (1 − fee_rate); the store's Shopify-side
    // ad_spend / cogs / fees / refunds were already baked into
    // base.net_profit by the aggregator.
    //   - upsell rolls into frontend revenue (base.revenue)
    //   - subs (Initial + Recurring + Salvage, or Paysight charges) is its
    //     own bucket
    const subRevenue = subs + upsell;
    const subContribution = subRevenue * (1 - feeRate);
    const frontend = base.revenue + upsell;
    const totalRev = frontend + subs;
    return {
      ...base,
      revenue: frontend,
      subs_revenue: subs,
      total_revenue: totalRev,
      // order_count stays Shopify-only so the parent row matches the expand
      // panel; subscription order count is surfaced separately as "+N subs".
      order_count: base.order_count,
      phx_order_count: subOrders + upsellOrders,
      net_profit: base.net_profit + subContribution,
      gross_profit: base.gross_profit + subRevenue,
      margin_pct:
        totalRev > 0
          ? ((base.net_profit + subContribution) / totalRev) * 100
          : 0,
    };
  });

  const totals = sumTotals(ledger);

  // Compute the effective days span for display (unique dates in the result set).
  const days =
    "days" in rangeSpec
      ? rangeSpec.days
      : Math.max(1, diffDays(rangeSpec.from, rangeSpec.to) + 1);

  return {
    stores,
    rows: ledger,
    totals,
    days,
    selectedStores: selected,
  };
}

function normalizeStoreFilter(f: string | string[]): string[] {
  if (Array.isArray(f)) return f.map((s) => s.toUpperCase());
  if (!f || f.toLowerCase() === "all") return [];
  return f
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// Collapse a phx range_from value to the same 'YYYY-MM-DD' string that
// daily_pnl.date returns, so the two maps key-match. range_from is a
// timestamptz stored at store-local midnight (PHX stores = America/New_York);
// a plain ISO .slice(0,10) would shift it a day west of midnight, so we format
// in the store timezone. A value that's already a plain 'YYYY-MM-DD' (no 'T')
// passes through unchanged.
const PHX_TZ = "America/New_York";
const phxDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: PHX_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function phxDayKey(value: string): string {
  if (!value.includes("T")) return value.slice(0, 10);
  return phxDayFmt.format(new Date(value));
}

function groupByDate(rows: RawPnlRow[]): Record<string, RawPnlRow[]> {
  const out: Record<string, RawPnlRow[]> = {};
  for (const r of rows) {
    (out[r.date] ||= []).push(r);
  }
  return out;
}

function aggregate(rows: RawPnlRow[]): DailyRow {
  const date = rows[0]?.date ?? "";
  let revenue = 0,
    cogs = 0,
    fees = 0,
    refunds = 0,
    ad_spend = 0,
    gross_profit = 0,
    net_profit = 0,
    orders = 0;
  for (const r of rows) {
    revenue += num(r.revenue);
    cogs += num(r.cogs);
    fees += num(r.fees);
    refunds += num(r.refunds);
    ad_spend += num(r.ad_spend);
    gross_profit += num(r.gross_profit);
    net_profit += num(r.net_profit);
    orders += r.order_count ?? 0;
  }
  const margin_pct = revenue > 0 ? (net_profit / revenue) * 100 : 0;
  return {
    date,
    revenue,
    subs_revenue: 0,
    total_revenue: revenue,
    cogs,
    fees,
    refunds,
    ad_spend,
    gross_profit,
    net_profit,
    margin_pct,
    order_count: orders,
    phx_order_count: 0,
  };
}

function toTotals(r: DailyRow): Totals {
  return {
    revenue: r.revenue,
    subs_revenue: r.subs_revenue,
    total_revenue: r.total_revenue,
    cogs: r.cogs,
    fees: r.fees,
    refunds: r.refunds,
    ad_spend: r.ad_spend,
    gross_profit: r.gross_profit,
    net_profit: r.net_profit,
    orders: r.order_count,
    roas: r.ad_spend > 0 ? r.total_revenue / r.ad_spend : 0,
    margin_pct: r.margin_pct,
  };
}

function sumTotals(rows: DailyRow[]): Totals {
  let revenue = 0,
    subs_revenue = 0,
    total_revenue = 0,
    cogs = 0,
    fees = 0,
    refunds = 0,
    ad_spend = 0,
    gross_profit = 0,
    net_profit = 0,
    orders = 0;
  for (const r of rows) {
    revenue += r.revenue;
    subs_revenue += r.subs_revenue;
    total_revenue += r.total_revenue;
    cogs += r.cogs;
    fees += r.fees;
    refunds += r.refunds;
    ad_spend += r.ad_spend;
    gross_profit += r.gross_profit;
    net_profit += r.net_profit;
    orders += r.order_count;
  }
  return {
    revenue,
    subs_revenue,
    total_revenue,
    cogs,
    fees,
    refunds,
    ad_spend,
    gross_profit,
    net_profit,
    orders,
    roas: ad_spend > 0 ? total_revenue / ad_spend : 0,
    margin_pct: total_revenue > 0 ? (net_profit / total_revenue) * 100 : 0,
  };
}

function emptyDailyRow(date: string): DailyRow {
  return {
    date,
    revenue: 0,
    subs_revenue: 0,
    total_revenue: 0,
    cogs: 0,
    fees: 0,
    refunds: 0,
    ad_spend: 0,
    gross_profit: 0,
    net_profit: 0,
    margin_pct: 0,
    order_count: 0,
    phx_order_count: 0,
  };
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
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

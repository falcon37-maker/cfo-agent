// Read-side queries for the dashboard and P&L pages.
// Aggregation is done in JS rather than SQL — 3 stores × ~180 days is small
// enough that a single `select … where date >= …` beats adding views/RPCs.

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  loadPhxDailyRows,
  type PhxSnapshot,
} from "@/lib/phx/queries";

// Stores for which PHX/Solvpath is the source of truth for revenue. For any
// other store, Shopify's daily_pnl stays the source (future stores that only
// use Shopify Payments land here by default).
const PHX_STORE_IDS = new Set(["NOVA", "NURA", "KOVA"]);

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
  order_count: number;
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

export async function loadStores(): Promise<StoreInfo[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select(
      "id, name, currency, timezone, shop_domain, processing_fee_pct",
    )
    .eq("is_active", true)
    .order("id");
  if (error) throw new Error(`loadStores: ${error.message}`);
  return (data ?? []).map((s) => ({
    ...s,
    processing_fee_pct: Number(s.processing_fee_pct ?? 0),
  })) as StoreInfo[];
}

/** Fetch raw daily_pnl rows (one per store-day) in the inclusive [from, to] window. */
async function loadPnlRowsInRange(from: string, to: string): Promise<RawPnlRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("daily_pnl")
    .select(
      "store_id, date, revenue, cogs, fees, refunds, ad_spend, gross_profit, net_profit, margin_pct, order_count",
    )
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: false });
  if (error) throw new Error(`loadPnlRowsInRange: ${error.message}`);
  return (data ?? []) as RawPnlRow[];
}

/** Convenience: last `days` days ending today (UTC). */
async function loadPnlRows(days: number): Promise<RawPnlRow[]> {
  const to = todayUtc();
  const from = addDays(to, -(days - 1));
  return loadPnlRowsInRange(from, to);
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
  rangeSpec?: { days: number } | { from: string; to: string },
): Promise<DashboardData> {
  const stores = await loadStores();

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
  const allRows = await loadPnlRowsInRange(priorFrom, to);
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
  shopify_orders: number; // count, all stores
  shopify_cogs: number;
  shopify_refunds: number;
  phx_revenue: number; // PHX total (frontend + subs + upsell), per-day actual
  phx_net_contribution: number; // phx_revenue × (1 − fee_rate)
  phx_subs_billed: number; // count of recurring + salvage tx on this day
  // Per-day actuals from PHX (no amortization), broken out for the table:
  phx_frontend_revenue: number; // Direct + Initial (Vip Initial included)
  phx_subs_revenue: number; // Recurring + Salvage
  phx_upsell_revenue: number;
  total_revenue: number;
  total_net_profit: number;
};

export type BlendedTotals = {
  shopify_revenue: number;
  shopify_ad_spend: number;
  shopify_net_profit: number;
  shopify_orders: number;
  shopify_cogs: number;
  shopify_refunds: number;
  phx_revenue: number;
  phx_net_contribution: number;
  phx_frontend_revenue: number;
  phx_subs_revenue: number;
  phx_upsell_revenue: number;
  phx_subs_billed: number;
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
  frontend: number; // direct + initial
  subs: number; // recurring + salvage
  upsell: number;
  total: number;
  subsBilledCount: number; // recurringCount + salvageCount
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
    const recurringCount = Number(json.recurringCount ?? 0);
    const salvageCount = Number(json.salvageCount ?? 0);

    const cur = out.get(date) ?? {
      frontend: 0,
      subs: 0,
      upsell: 0,
      total: 0,
      subsBilledCount: 0,
    };
    cur.frontend += direct + initial;
    cur.subs += recurring + salvage;
    cur.upsell += upsell;
    cur.total += direct + initial + recurring + salvage + upsell;
    cur.subsBilledCount += recurringCount + salvageCount;
    out.set(date, cur);
  }
  return out;
}

export async function loadBlendedDashboardData(
  rangeSpec?: { days: number } | { from: string; to: string },
): Promise<BlendedDashboardData> {
  const stores = await loadStores();
  const feeRate =
    Number(stores.find((s) => s.id !== "PORTFOLIO")?.processing_fee_pct ?? 0.1) || 0.1;

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
  const allPnl = await loadPnlRowsInRange(priorFrom, to);
  const curPnl = allPnl.filter((r) => r.date >= from && r.date <= to);
  const priorPnl = allPnl.filter(
    (r) => r.date >= priorFrom && r.date <= priorTo,
  );

  // Per-day per-store PHX rows for both windows. No amortization — each row
  // already represents one store's actual transactions on one day.
  const phxStoreIds = stores
    .map((s) => s.id)
    .filter((id) => PHX_STORE_IDS.has(id));
  const phxCur = await loadPhxDailyRows(from, to, phxStoreIds);
  const phxPrior = await loadPhxDailyRows(priorFrom, priorTo, phxStoreIds);
  const phxByDayCur = rollupPhxByDay(phxCur);
  const phxByDayPrior = rollupPhxByDay(phxPrior);

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
    // PHX stores' real net = PHX revenue − processor fees − the Shopify-side
    // costs they still incur (logged ad_spend / cogs / refunds / fees).
    // Without this subtraction the dashboard double-shows costs in the row
    // while ignoring them in net profit.
    const phxContribution =
      phx.total * (1 - feeRate)
      - phxShop.ad_spend
      - phxShop.cogs
      - phxShop.refunds
      - phxShop.fees;
    const nonPhxContribution = nonPhxShop.net_profit;
    daily.push({
      date: cur,
      shopify_revenue: round2(nonPhxShop.revenue),
      shopify_ad_spend: round2(allShop.ad_spend),
      shopify_net_profit: round2(nonPhxShop.net_profit),
      shopify_orders: allShop.order_count,
      shopify_cogs: round2(allShop.cogs),
      shopify_refunds: round2(allShop.refunds),
      phx_revenue: round2(phx.total),
      phx_net_contribution: round2(phxContribution),
      phx_subs_billed: phx.subsBilledCount,
      phx_frontend_revenue: round2(phx.frontend),
      phx_subs_revenue: round2(phx.subs),
      phx_upsell_revenue: round2(phx.upsell),
      total_revenue: round2(nonPhxShop.revenue + phx.total),
      total_net_profit: round2(nonPhxContribution + phxContribution),
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
    const phxContribution =
      phx.total * (1 - feeRate)
      - phxShop.ad_spend
      - phxShop.cogs
      - phxShop.refunds
      - phxShop.fees;
    priorDaily.push({
      date: curP,
      shopify_revenue: round2(nonPhxShop.revenue),
      shopify_ad_spend: round2(allShop.ad_spend),
      shopify_net_profit: round2(nonPhxShop.net_profit),
      shopify_orders: allShop.order_count,
      shopify_cogs: round2(allShop.cogs),
      shopify_refunds: round2(allShop.refunds),
      phx_revenue: round2(phx.total),
      phx_net_contribution: round2(phxContribution),
      phx_subs_billed: phx.subsBilledCount,
      phx_frontend_revenue: round2(phx.frontend),
      phx_subs_revenue: round2(phx.subs),
      phx_upsell_revenue: round2(phx.upsell),
      total_revenue: round2(nonPhxShop.revenue + phx.total),
      total_net_profit: round2(nonPhxShop.net_profit + phxContribution),
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
    shopify_cogs = 0,
    shopify_refunds = 0,
    phx_revenue = 0,
    phx_net_contribution = 0,
    phx_frontend_revenue = 0,
    phx_subs_revenue = 0,
    phx_upsell_revenue = 0,
    phx_subs_billed = 0;
  for (const r of rows) {
    shopify_revenue += r.shopify_revenue;
    shopify_ad_spend += r.shopify_ad_spend;
    shopify_net_profit += r.shopify_net_profit;
    shopify_orders += r.shopify_orders;
    shopify_cogs += r.shopify_cogs;
    shopify_refunds += r.shopify_refunds;
    phx_revenue += r.phx_revenue;
    phx_net_contribution += r.phx_net_contribution;
    phx_frontend_revenue += r.phx_frontend_revenue;
    phx_subs_revenue += r.phx_subs_revenue;
    phx_upsell_revenue += r.phx_upsell_revenue;
    phx_subs_billed += r.phx_subs_billed;
  }
  const total_revenue = shopify_revenue + phx_revenue;
  const total_net_profit = shopify_net_profit + phx_net_contribution;
  return {
    shopify_revenue: round2(shopify_revenue),
    shopify_ad_spend: round2(shopify_ad_spend),
    shopify_net_profit: round2(shopify_net_profit),
    shopify_orders,
    shopify_cogs: round2(shopify_cogs),
    shopify_refunds: round2(shopify_refunds),
    phx_revenue: round2(phx_revenue),
    phx_net_contribution: round2(phx_net_contribution),
    phx_frontend_revenue: round2(phx_frontend_revenue),
    phx_subs_revenue: round2(phx_subs_revenue),
    phx_upsell_revenue: round2(phx_upsell_revenue),
    phx_subs_billed,
    total_revenue: round2(total_revenue),
    total_net_profit: round2(total_net_profit),
    roas: shopify_ad_spend > 0 ? total_revenue / shopify_ad_spend : 0,
    margin_pct: total_revenue > 0 ? (total_net_profit / total_revenue) * 100 : 0,
  };
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
): Promise<PnlLedger> {
  const stores = await loadStores();
  const rows =
    "from" in rangeSpec
      ? await loadPnlRowsInRange(rangeSpec.from, rangeSpec.to)
      : await loadPnlRows(rangeSpec.days);

  const selected = normalizeStoreFilter(storeFilter);
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
  const phxRows = await loadPhxDailyRows(winFrom, winTo, phxStoresInFilter);

  // Subs Rev = Recurring + Salvage only. PHX "Initial" and "Direct" both
  // flow through the Shopify checkout, so daily_pnl.revenue already counts
  // them — adding revenue_initial here would double-count first-month
  // subscription sign-ups.
  const phxSubsByDate = new Map<
    string,
    { revenue: number; orders: number }
  >();
  for (const r of phxRows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const subs =
      Number(r.revenue_recurring ?? 0) + Number(r.revenue_salvage ?? 0);
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    const subOrders =
      Number(j.recurringCount ?? 0) + Number(j.salvageCount ?? 0);
    const cur = phxSubsByDate.get(r.range_from) ?? { revenue: 0, orders: 0 };
    cur.revenue += subs;
    cur.orders += subOrders;
    phxSubsByDate.set(r.range_from, cur);
  }

  const feeRate =
    Number(stores.find((s) => s.id !== "PORTFOLIO")?.processing_fee_pct ?? 0.1) ||
    0.1;

  const byDate = groupByDate(filtered);
  const ordered = Object.keys(byDate).sort().reverse();
  const ledger: DailyRow[] = ordered.map((d) => {
    const base = aggregate(byDate[d]);
    const subs = phxSubsByDate.get(d);
    if (!subs || subs.revenue === 0) return base;
    // Subs add to revenue. Net profit picks up subs * (1 − fee_rate); the
    // store's Shopify-side ad_spend / cogs / fees / refunds were already
    // baked into base.net_profit by the aggregator.
    const subsContribution = subs.revenue * (1 - feeRate);
    const totalRev = base.revenue + subs.revenue;
    return {
      ...base,
      subs_revenue: subs.revenue,
      total_revenue: totalRev,
      // PHX rebills + salvage hit Solvpath but never the Shopify storefront,
      // so they're additive to Shopify's order_count.
      order_count: base.order_count + subs.orders,
      net_profit: base.net_profit + subsContribution,
      gross_profit: base.gross_profit + subs.revenue,
      margin_pct:
        totalRev > 0 ? ((base.net_profit + subsContribution) / totalRev) * 100 : 0,
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

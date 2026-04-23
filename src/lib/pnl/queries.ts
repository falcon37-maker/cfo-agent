// Read-side queries for the dashboard and P&L pages.
// Aggregation is done in JS rather than SQL — 3 stores × ~180 days is small
// enough that a single `select … where date >= …` beats adding views/RPCs.

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  loadPhxStoreSnapshotsOverlapping,
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
  revenue: number;
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
  shopify_revenue: number;
  shopify_ad_spend: number;
  shopify_net_profit: number;
  shopify_orders: number;
  shopify_cogs: number;
  shopify_refunds: number;
  phx_revenue: number; // amortized recurring + salvage
  phx_net_contribution: number; // phx_revenue × (1 − fee_rate)
  phx_subs_billed: number; // amortized recurring_subscription_count / period days
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

/**
 * Amortize a single per-store PHX snapshot's revenue (direct + initial +
 * recurring + salvage + upsell — i.e. total) across the days of its period.
 * Returns a Map<date, amortizedTotal>.
 *
 * Used when PHX is the source of truth for a store's revenue: we take every
 * bucket PHX produced and spread it evenly across the reporting period.
 */
function amortizePhxTotalByDay(snaps: PhxSnapshot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of snaps) {
    if (!s.range_from || !s.range_to) continue;
    // Prefer the pre-summed revenue_total; fall back to the buckets.
    const total =
      s.revenue_total != null
        ? Number(s.revenue_total)
        : Number(s.revenue_direct ?? 0) +
          Number(s.revenue_initial ?? 0) +
          Number(s.revenue_recurring ?? 0) +
          Number(s.revenue_salvage ?? 0) +
          Number(s.revenue_upsell ?? 0);
    if (!(total > 0)) continue;
    const days = diffDays(s.range_from, s.range_to) + 1;
    if (days <= 0) continue;
    const perDay = total / days;
    let cur = s.range_from;
    for (let i = 0; i < days; i++) {
      out.set(cur, (out.get(cur) ?? 0) + perDay);
      cur = addDays(cur, 1);
    }
  }
  return out;
}

/** Amortize PHX recurring_subscription_count across a snapshot's period days. */
function amortizeSubsByDay(snaps: PhxSnapshot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of snaps) {
    if (!s.range_from || !s.range_to) continue;
    const count = Number(s.recurring_subscription_count ?? 0);
    if (count <= 0) continue;
    const days = diffDays(s.range_from, s.range_to) + 1;
    if (days <= 0) continue;
    const perDay = count / days;
    let cur = s.range_from;
    for (let i = 0; i < days; i++) {
      out.set(cur, (out.get(cur) ?? 0) + perDay);
      cur = addDays(cur, 1);
    }
  }
  return out;
}

/**
 * Sum multiple per-store amortized day-maps into one portfolio-level map.
 */
function sumMaps(maps: Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of maps) {
    for (const [k, v] of m) out.set(k, (out.get(k) ?? 0) + v);
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

  // Per-store PHX snapshots for both windows — NOT the PORTFOLIO rollup, so
  // we can amortize each PHX store separately.
  const phxStoreIds = stores
    .map((s) => s.id)
    .filter((id) => PHX_STORE_IDS.has(id));
  const phxCur = await loadPhxStoreSnapshotsOverlapping(from, to, phxStoreIds);
  const phxPrior = await loadPhxStoreSnapshotsOverlapping(
    priorFrom,
    priorTo,
    phxStoreIds,
  );

  // Amortize PHX per-day per-store. Subs-billed rolls up across all PHX stores.
  const phxByDayByStoreCur = new Map<string, Map<string, number>>();
  const phxByDayByStorePrior = new Map<string, Map<string, number>>();
  for (const sid of phxStoreIds) {
    phxByDayByStoreCur.set(
      sid,
      amortizePhxTotalByDay(phxCur.filter((s) => s.store_id === sid)),
    );
    phxByDayByStorePrior.set(
      sid,
      amortizePhxTotalByDay(phxPrior.filter((s) => s.store_id === sid)),
    );
  }
  const phxByDayCur = sumMaps([...phxByDayByStoreCur.values()]);
  const phxByDayPrior = sumMaps([...phxByDayByStorePrior.values()]);
  const phxSubsByDayCur = amortizeSubsByDay(phxCur);
  const phxSubsByDayPrior = amortizeSubsByDay(phxPrior);

  // Split Shopify rows: keep non-PHX-store rows as the revenue source;
  // PHX-store rows only contribute cogs/refunds/ad_spend/orders (revenue is
  // taken from PHX for those stores).
  const isPhxStore = (row: RawPnlRow) => PHX_STORE_IDS.has(row.store_id);
  const shopifyByDateNonPhx = groupByDate(curPnl.filter((r) => !isPhxStore(r)));
  const shopifyByDateAll = groupByDate(curPnl);
  const shopifyByDatePriorNonPhx = groupByDate(
    priorPnl.filter((r) => !isPhxStore(r)),
  );
  const shopifyByDatePriorAll = groupByDate(priorPnl);

  // Build the daily array for the current range (every day in [from..to]).
  const daily: BlendedDailyRow[] = [];
  let cur = from;
  while (cur <= to) {
    const nonPhxShop = aggregate(shopifyByDateNonPhx[cur] ?? []);
    const allShop = aggregate(shopifyByDateAll[cur] ?? []);
    const phxRev = phxByDayCur.get(cur) ?? 0;
    const phxContribution = phxRev * (1 - feeRate);
    const nonPhxContribution = nonPhxShop.net_profit;
    daily.push({
      date: cur,
      // "shopify_revenue" now means "revenue from non-PHX Shopify-only stores"
      // (PHX stores' Shopify-side revenue is replaced with PHX's numbers).
      shopify_revenue: round2(nonPhxShop.revenue),
      // Ad spend, COGS, refunds, orders cover ALL stores (Shopify still sees
      // every order — including PHX rebills — so these counts stay authoritative).
      shopify_ad_spend: round2(allShop.ad_spend),
      shopify_net_profit: round2(nonPhxShop.net_profit),
      shopify_orders: allShop.order_count,
      shopify_cogs: round2(allShop.cogs),
      shopify_refunds: round2(allShop.refunds),
      phx_revenue: round2(phxRev),
      phx_net_contribution: round2(phxContribution),
      phx_subs_billed: Math.round(phxSubsByDayCur.get(cur) ?? 0),
      total_revenue: round2(nonPhxShop.revenue + phxRev),
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
    const phxRev = phxByDayPrior.get(curP) ?? 0;
    priorDaily.push({
      date: curP,
      shopify_revenue: round2(nonPhxShop.revenue),
      shopify_ad_spend: round2(allShop.ad_spend),
      shopify_net_profit: round2(nonPhxShop.net_profit),
      shopify_orders: allShop.order_count,
      shopify_cogs: round2(allShop.cogs),
      shopify_refunds: round2(allShop.refunds),
      phx_revenue: round2(phxRev),
      phx_net_contribution: round2(phxRev * (1 - feeRate)),
      phx_subs_billed: Math.round(phxSubsByDayPrior.get(curP) ?? 0),
      total_revenue: round2(nonPhxShop.revenue + phxRev),
      total_net_profit: round2(
        nonPhxShop.net_profit + phxRev * (1 - feeRate),
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
    shopify_cogs = 0,
    shopify_refunds = 0,
    phx_revenue = 0,
    phx_net_contribution = 0;
  for (const r of rows) {
    shopify_revenue += r.shopify_revenue;
    shopify_ad_spend += r.shopify_ad_spend;
    shopify_net_profit += r.shopify_net_profit;
    shopify_orders += r.shopify_orders;
    shopify_cogs += r.shopify_cogs;
    shopify_refunds += r.shopify_refunds;
    phx_revenue += r.phx_revenue;
    phx_net_contribution += r.phx_net_contribution;
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
  storeFilter: string; // 'all' | store id
};

/** Filtered/aggregated ledger for /pnl.
 *  Pass either `days` (rolling window ending today) or an explicit `{from, to}`. */
export async function loadPnlLedger(
  rangeSpec: { days: number } | { from: string; to: string },
  storeFilter: string,
): Promise<PnlLedger> {
  const stores = await loadStores();
  const rows =
    "from" in rangeSpec
      ? await loadPnlRowsInRange(rangeSpec.from, rangeSpec.to)
      : await loadPnlRows(rangeSpec.days);

  const filtered =
    storeFilter === "all"
      ? rows
      : rows.filter((r) => r.store_id === storeFilter.toUpperCase());

  const byDate = groupByDate(filtered);
  const ordered = Object.keys(byDate).sort().reverse();
  const ledger: DailyRow[] = ordered.map((d) => aggregate(byDate[d]));

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
    storeFilter,
  };
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
    cogs: r.cogs,
    fees: r.fees,
    refunds: r.refunds,
    ad_spend: r.ad_spend,
    gross_profit: r.gross_profit,
    net_profit: r.net_profit,
    orders: r.order_count,
    roas: r.ad_spend > 0 ? r.revenue / r.ad_spend : 0,
    margin_pct: r.margin_pct,
  };
}

function sumTotals(rows: DailyRow[]): Totals {
  let revenue = 0,
    cogs = 0,
    fees = 0,
    refunds = 0,
    ad_spend = 0,
    gross_profit = 0,
    net_profit = 0,
    orders = 0;
  for (const r of rows) {
    revenue += r.revenue;
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
    cogs,
    fees,
    refunds,
    ad_spend,
    gross_profit,
    net_profit,
    orders,
    roas: ad_spend > 0 ? revenue / ad_spend : 0,
    margin_pct: revenue > 0 ? (net_profit / revenue) * 100 : 0,
  };
}

function emptyDailyRow(date: string): DailyRow {
  return {
    date,
    revenue: 0,
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

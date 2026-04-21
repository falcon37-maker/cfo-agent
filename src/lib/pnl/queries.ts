// Read-side queries for the dashboard and P&L pages.
// Aggregation is done in JS rather than SQL — 3 stores × ~180 days is small
// enough that a single `select … where date >= …` beats adding views/RPCs.

import { supabaseAdmin } from "@/lib/supabase/admin";

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

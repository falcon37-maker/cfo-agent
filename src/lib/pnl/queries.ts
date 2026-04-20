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
  series30: DailyRow[]; // aggregated across all stores
  last10: DailyRow[]; // aggregated across all stores
  storeMixToday: PerStorePoint[];
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

export async function loadDashboardData(): Promise<DashboardData> {
  const stores = await loadStores();
  const rows = await loadPnlRows(30);

  const byDate = groupByDate(rows);
  const today = todayUtc();
  const yesterday = addDays(today, -1);

  // Aggregate series for the chart + sparks (30 most recent days, oldest→newest)
  const sortedDates = Object.keys(byDate).sort();
  // keep only the last 30 dates (should already be within 30, but safety)
  const seriesDates = sortedDates.slice(-30);
  const series30: DailyRow[] = seriesDates.map((d) => aggregate(byDate[d]));

  // 10-day consolidated P&L (most recent first)
  const last10: DailyRow[] = [...series30].reverse().slice(0, 10);

  const todayAgg = byDate[today]
    ? aggregate(byDate[today])
    : emptyDailyRow(today);
  const ydayAgg = byDate[yesterday]
    ? aggregate(byDate[yesterday])
    : emptyDailyRow(yesterday);

  const todayTotals = toTotals(todayAgg);
  const yesterdayTotals = toTotals(ydayAgg);

  const kpiSparks = {
    revenue: series30.map((r) => r.revenue),
    ad_spend: series30.map((r) => r.ad_spend),
    roas: series30.map((r) =>
      r.ad_spend > 0 ? r.revenue / r.ad_spend : 0,
    ),
    net_profit: series30.map((r) => r.net_profit),
  };

  // Store mix for today (fall back to yesterday if today is empty)
  const mixRows = (byDate[today] && byDate[today].some((r) => Number(r.revenue) > 0))
    ? byDate[today]
    : byDate[yesterday] ?? [];
  const storeMixToday: PerStorePoint[] = stores.map((s) => {
    const row = mixRows.find((r) => r.store_id === s.id);
    return {
      store: s.id,
      revenue: num(row?.revenue),
      ad_spend: num(row?.ad_spend),
      net_profit: num(row?.net_profit),
      orders: row?.order_count ?? 0,
    };
  });

  return {
    stores,
    today,
    todayTotals,
    yesterdayTotals,
    kpiSparks,
    series30,
    last10,
    storeMixToday,
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

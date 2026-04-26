// Sequential backfill: for each date in [startDate, endDate], pull orders from
// Shopify into `daily_orders`, then compute `daily_pnl`.

import { syncDailyOrders, DailyPullResult } from "@/lib/shopify/sync";
import { computeDailyPnl } from "@/lib/pnl/compute";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type BackfillDayResult = {
  date: string;
  pull: DailyPullResult;
  netProfit: number;
};

/** Inclusive date range. Dates are YYYY-MM-DD (in the store's tz). */
export async function backfillRange(
  storeCode: string,
  startDate: string,
  endDate: string,
  tenantId: string,
): Promise<BackfillDayResult[]> {
  const dates = enumerateDates(startDate, endDate);
  const results: BackfillDayResult[] = [];

  for (const date of dates) {
    const pull = await syncDailyOrders(storeCode, date, tenantId);
    const pnl = await computeDailyPnl(storeCode, date, tenantId);
    results.push({ date, pull, netProfit: pnl?.net_profit ?? 0 });
  }

  return results;
}

/** Convenience: last `days` days, ending today in the store's tz (inclusive). */
export async function backfillLastNDays(
  storeCode: string,
  days: number,
  tenantId: string,
): Promise<BackfillDayResult[]> {
  const sb = supabaseAdmin();
  const { data: store } = await sb
    .from("stores")
    .select("timezone")
    .eq("tenant_id", tenantId)
    .eq("id", storeCode.toUpperCase())
    .maybeSingle();
  const tz = store?.timezone ?? "UTC";

  const today = ymdInTz(new Date(), tz);
  const start = addDays(today, -(days - 1));
  return backfillRange(storeCode, start, today, tenantId);
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function ymdInTz(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

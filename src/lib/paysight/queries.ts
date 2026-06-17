// Dashboard read queries for Paysight data.
//
// Paysight rows live in paysight_subscriptions / paysight_transactions.
// These helpers roll them up for the Subscriptions page so Paysight can be
// shown side-by-side with Phoenix (the combined view the client asked for).

import { supabaseAdmin } from "@/lib/supabase/admin";

export type PaysightSummary = {
  hasData: boolean;
  activeSubscribers: number;
  // Window totals (success only):
  successfulTransactions: number;
  totalTransactions: number;
  revenue: number;
  refundedCount: number;
  chargebackCount: number;
  byStore: Array<{ store: string; revenue: number; transactions: number }>;
  latestTxnDate: string | null;
};

/**
 * Roll up Paysight transactions + subscriptions for the [from, to] window.
 * Revenue counts only successful, non-refund application transactions.
 */
export async function loadPaysightSummary(
  tenantId: string,
  from: string,
  to: string,
): Promise<PaysightSummary> {
  const sb = supabaseAdmin();

  // Page through — Supabase caps a response at 1000 rows; a multi-week window
  // exceeds that and would silently drop transactions from the totals.
  const txns: Array<{
    store_id: string | null;
    amount: number | null;
    success: boolean | null;
    refunded: boolean | null;
    charged_back: boolean | null;
    application_id: number | null;
    txn_date: string | null;
  }> = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await sb
      .from("paysight_transactions")
      .select(
        "store_id, amount, success, refunded, charged_back, application_id, txn_date",
      )
      .eq("tenant_id", tenantId)
      .gte("txn_date", from)
      .lte("txn_date", to)
      .order("txn_date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (!data || data.length === 0) break;
    txns.push(...data);
    if (data.length < PAGE) break;
  }

  const { count: activeSubscribers } = await sb
    .from("paysight_subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("active", true);

  const rows = txns ?? [];
  const byStoreMap = new Map<string, { revenue: number; transactions: number }>();
  let revenue = 0;
  let successfulTransactions = 0;
  let refundedCount = 0;
  let chargebackCount = 0;
  let latestTxnDate: string | null = null;

  for (const t of rows) {
    const store = (t.store_id as string | null) ?? "OTHER";
    const cur = byStoreMap.get(store) ?? { revenue: 0, transactions: 0 };
    cur.transactions += 1;
    // applicationId 200=Refund, 201=Chargeback, 202=CB Alert — exclude from
    // positive revenue. Otherwise count successful charges.
    const isAdjustment =
      t.application_id === 200 ||
      t.application_id === 201 ||
      t.application_id === 202;
    if (t.success && !isAdjustment) {
      cur.revenue += Number(t.amount ?? 0);
      revenue += Number(t.amount ?? 0);
      successfulTransactions += 1;
    }
    if (t.refunded) refundedCount += 1;
    if (t.charged_back) chargebackCount += 1;
    byStoreMap.set(store, cur);
    const d = t.txn_date as string | null;
    if (d && (!latestTxnDate || d > latestTxnDate)) latestTxnDate = d;
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const byStore = [...byStoreMap.entries()]
    .map(([store, v]) => ({
      store,
      revenue: r2(v.revenue),
      transactions: v.transactions,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    hasData: rows.length > 0 || (activeSubscribers ?? 0) > 0,
    activeSubscribers: activeSubscribers ?? 0,
    successfulTransactions,
    totalTransactions: rows.length,
    revenue: r2(revenue),
    refundedCount,
    chargebackCount,
    byStore,
    latestTxnDate,
  };
}

export type PaysightDaySubs = {
  /** BILLED subscription revenue for the day — successful rebills only
   *  (payment_number >= 1). Newly-acquired checkout orders (cycle 0) are
   *  store revenue, not subscription billing, and are excluded. */
  subs: number;
  /** Count of successful billed charges that day. */
  subOrders: number;
};

/**
 * Per-date Paysight BILLED subscription revenue + charge count for [from, to].
 *
 * Client spec (Jun 2026): "Subs Rev = only what was billed that day from
 * subs". A Paysight charge counts as billed when payment_number >= 1 (a
 * recurring rebill of an existing subscription). Cycle-0 charges are the
 * customer's first checkout purchase — newly-acquired revenue that already
 * shows up as store revenue — so they're excluded here. Rows synced before
 * the Admin-API switch have payment_number NULL and are excluded too (they
 * are all cycle-0 checkout orders; verified Jun 2026).
 *
 * Adds ON TOP of Phoenix billed revenue in the P&L blend — each rebill is
 * charged on exactly one platform, so the two never double-count.
 * Keyed by YYYY-MM-DD.
 */
export async function loadPaysightSubsByDate(
  tenantId: string,
  from: string,
  to: string,
  storeIds?: string[],
): Promise<Map<string, PaysightDaySubs>> {
  const sb = supabaseAdmin();
  // Page through results — Supabase caps a single response at 1000 rows, and a
  // multi-week window exceeds that, silently dropping rows (the oldest dates
  // collapse to near-zero). Loop until a short page signals the end.
  const rows: Array<{
    txn_date: string | null;
    amount: number | null;
    success: boolean | null;
    application_id: number | null;
    payment_number: number | null;
  }> = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = sb
      .from("paysight_transactions")
      .select("txn_date, amount, success, application_id, store_id, payment_number")
      .eq("tenant_id", tenantId)
      .gte("txn_date", from)
      .lte("txn_date", to)
      .gte("payment_number", 1) // billed rebills only — see doc comment
      .order("txn_date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (storeIds && storeIds.length) q = q.in("store_id", storeIds);
    const { data } = await q;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const map = new Map<string, PaysightDaySubs>();
  for (const t of rows) {
    const date = t.txn_date as string | null;
    if (!date) continue;
    const isAdjustment =
      t.application_id === 200 ||
      t.application_id === 201 ||
      t.application_id === 202;
    if (!t.success || isAdjustment) continue;
    const cur = map.get(date) ?? { subs: 0, subOrders: 0 };
    cur.subs += Number(t.amount ?? 0);
    cur.subOrders += 1;
    map.set(date, cur);
  }
  // round
  for (const [k, v] of map) {
    map.set(k, { subs: Math.round(v.subs * 100) / 100, subOrders: v.subOrders });
  }
  return map;
}

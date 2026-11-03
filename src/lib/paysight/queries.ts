// Dashboard read queries for Paysight data.
//
// Paysight rows live in paysight_subscriptions / paysight_transactions.
// These helpers roll them up for the Subscriptions page so Paysight can be
// shown side-by-side with Phoenix (the combined view the client asked for).

import { supabaseAdmin } from "@/lib/supabase/admin";

function txnBaseQuery(tenantId: string, select: string) {
  return supabaseAdmin()
    .from("paysight_transactions")
    .select(select)
    .eq("tenant_id", tenantId);
}
type TxnQuery = ReturnType<typeof txnBaseQuery>;

const PAGE = 1000;
/** Days per slice. A week of subscription-store traffic is ~1–2 pages and
 *  returns in under a second; much wider and the planner can fall back to a
 *  primary-key walk that hits the statement timeout. */
const SLICE_DAYS = 7;
/** Slices in flight per call. Callers often run several loaders in parallel,
 *  and too many concurrent requests exhaust the Supabase connection pool
 *  (Cloudflare 522) — keep this small. */
const SLICE_CONCURRENCY = 3;

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Split inclusive [from, to] into consecutive SLICE_DAYS-long windows. */
function dateSlices(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let s = from; s <= to; s = addDaysYmd(s, SLICE_DAYS)) {
    const e = addDaysYmd(s, SLICE_DAYS - 1);
    out.push([s, e < to ? e : to]);
  }
  return out;
}

/**
 * Fetch every paysight_transactions row in [from, to] matching `filter`.
 *
 * The window is fetched in WEEK-SIZED SLICES (a few in parallel). A single
 * wide query ordered by `id` and paged with OFFSET makes Postgres walk the
 * primary key across the whole table; past ~a month that hits the statement
 * timeout (57014). The old loops ignored the error and just stopped paging, so
 * wider ranges silently lost Paysight revenue/orders (Oct 26 showed $3,968 of
 * Subs Rev on the 7d view and $0 on the 31d view). A short slice is served by
 * the (tenant_id, txn_date) index and stays fast at any range.
 *
 * Errors are retried once, then THROWN — a partial result must never render
 * as if it were the real number.
 */
async function fetchPaysightTxns<T>(
  tenantId: string,
  from: string,
  to: string,
  select: string,
  filter: (q: TxnQuery) => TxnQuery = (q) => q,
): Promise<T[]> {
  const fetchSlice = async ([sFrom, sTo]: [string, string]): Promise<T[]> => {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const run = () =>
        filter(txnBaseQuery(tenantId, select))
          .gte("txn_date", sFrom)
          .lte("txn_date", sTo)
          // Unique-key ordering keeps pagination deterministic within a slice.
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
      let { data, error } = await run();
      if (error) {
        await new Promise((r) => setTimeout(r, 500));
        ({ data, error } = await run());
      }
      if (error) {
        throw new Error(
          `paysight_transactions ${sFrom}..${sTo}: ${error.message.slice(0, 200)}`,
        );
      }
      const page = (data ?? []) as T[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return rows;
  };

  const slices = dateSlices(from, to);
  const out: T[] = [];
  for (let i = 0; i < slices.length; i += SLICE_CONCURRENCY) {
    const batch = await Promise.all(
      slices.slice(i, i + SLICE_CONCURRENCY).map(fetchSlice),
    );
    for (const rows of batch) out.push(...rows);
  }
  return out;
}

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

  const txns = await fetchPaysightTxns<{
    store_id: string | null;
    amount: number | null;
    success: boolean | null;
    refunded: boolean | null;
    charged_back: boolean | null;
    application_id: number | null;
    txn_date: string | null;
  }>(
    tenantId,
    from,
    to,
    "store_id, amount, success, refunded, charged_back, application_id, txn_date",
  );

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

/**
 * Count of currently-active Paysight subscriptions.
 *
 * Paysight is a SEPARATE CRM from Phoenix/Solvpath — the Subscriptions page's
 * "Active Subscribers" card reads its subscriber count from Solvpath's
 * /customers endpoint, which knows nothing about Paysight. Post-migration
 * (subs start 2026-05-30) most new subscribers live here, so leaving this out
 * understated the card badly.
 *
 * Counts only genuinely-active subscriptions: `active` is Paysight's own flag,
 * and FROZEN subscriptions are excluded — those are paused (billing stopped,
 * not cancelled) so they aren't billing anyone and shouldn't inflate the
 * headline. `frozen` is nullable, hence `not(is true)` rather than
 * `eq(false)`, which would silently drop NULL rows.
 * Uses a HEAD count so a 6k-row table costs one cheap query.
 *
 * `storeIds` scopes to specific stores; omit for the whole portfolio.
 */
export async function loadPaysightActiveSubscribers(
  tenantId: string,
  storeIds?: string[],
): Promise<number> {
  const sb = supabaseAdmin();
  let q = sb
    .from("paysight_subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .not("frozen", "is", true);
  if (storeIds && storeIds.length > 0) q = q.in("store_id", storeIds);
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
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
export type PaysightFrontend = {
  /** New subscribers = DISTINCT customers that day (de-duped). The clean CPA /
   *  cost-per-sub denominator. */
  newSubs: number;
  /** Upsell orders = extra cycle-0 orders from a customer who already has one
   *  that day (2nd+ purchase = upsell add-on). newSubs + upsell = total orders. */
  upsell: number;
};

/**
 * Frontend (checkout) orders per day from Paysight, split into NEW SUBS
 * (distinct customers — the clean count) and UPSELL ORDERS (extra orders from
 * the same customer). Client spec (Jun 2026): an upsell generates a 2nd order,
 * so count new subs per customer ID and break upsells out separately, since
 * order count is the CPA / cost-per-sub denominator.
 *
 * A frontend order = a successful cycle-0 charge (payment_number = 0). Per day:
 *   newSubs = distinct customer_id
 *   upsell  = (successful cycle-0 txns) − newSubs
 *   total   = newSubs + upsell  (ties out to the per-transaction count)
 */
export async function loadPaysightFrontendOrdersByDate(
  tenantId: string,
  from: string,
  to: string,
  storeIds?: string[],
): Promise<Map<string, PaysightFrontend>> {
  // An explicit empty store list means "no stores in scope" → no rows.
  // (undefined still means "all stores".) Without this guard the `.in()`
  // filter below is skipped for `[]`, silently returning every store's data —
  // which leaked subscription-store rows into drop-ship-only callers.
  if (storeIds && storeIds.length === 0) return new Map();
  // Day-sliced + id-ordered paging (see fetchPaysightTxns). Ordering by a
  // UNIQUE key matters: txn_date alone is non-deterministic across page
  // boundaries and once corrupted the per-day distinct-customer counts.
  const rows = await fetchPaysightTxns<{
    txn_date: string | null;
    success: boolean | null;
    customer_id: number | null;
    payment_number: number | null;
    application_id: number | null;
  }>(
    tenantId,
    from,
    to,
    "txn_date, success, customer_id, store_id, payment_number, application_id",
    (q) => {
      q = q
        .eq("payment_number", 0) // cycle-0 = at-checkout frontend purchase
        .eq("success", true); // declines never count — skip them server-side
      return storeIds && storeIds.length ? q.in("store_id", storeIds) : q;
    },
  );

  // Per day: distinct customers (= new subs) and total successful cycle-0 txns.
  const byDate = new Map<string, { customers: Set<number>; total: number }>();
  for (const t of rows) {
    const date = t.txn_date as string | null;
    if (!date || !t.success || t.customer_id == null) continue;
    const isAdjustment =
      t.application_id === 200 ||
      t.application_id === 201 ||
      t.application_id === 202;
    if (isAdjustment) continue;
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = { customers: new Set<number>(), total: 0 };
      byDate.set(date, bucket);
    }
    bucket.customers.add(t.customer_id);
    bucket.total += 1;
  }
  const map = new Map<string, PaysightFrontend>();
  for (const [date, b] of byDate) {
    const newSubs = b.customers.size;
    map.set(date, { newSubs, upsell: b.total - newSubs });
  }
  return map;
}

export async function loadPaysightSubsByDate(
  tenantId: string,
  from: string,
  to: string,
  storeIds?: string[],
): Promise<Map<string, PaysightDaySubs>> {
  // An explicit empty store list means "no stores in scope" → no rows.
  // (undefined still means "all stores".) Without this guard the `.in()`
  // filter below is skipped for `[]`, silently returning every store's data —
  // which leaked subscription-store rows into drop-ship-only callers.
  if (storeIds && storeIds.length === 0) return new Map();
  // Day-sliced paging with errors surfaced (see fetchPaysightTxns) — a
  // silently-truncated read here is what zeroed Subs Rev on wide ranges.
  const rows = await fetchPaysightTxns<{
    txn_date: string | null;
    amount: number | null;
    success: boolean | null;
    application_id: number | null;
    payment_number: number | null;
  }>(
    tenantId,
    from,
    to,
    "txn_date, amount, success, application_id, store_id, payment_number",
    (q) => {
      q = q
        .gte("payment_number", 1) // billed rebills only — see doc comment
        .eq("success", true); // ~half of rebill attempts decline; skip them
      return storeIds && storeIds.length ? q.in("store_id", storeIds) : q;
    },
  );

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

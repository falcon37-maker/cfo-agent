// Solvpath → phx_summary_snapshots backfill.
//
// For a given [from, to] window, iterate every active/cancelled/paused
// customer, pull their transaction history, filter to our 3 stores by
// transaction Domain, and bucket revenue into direct / initial / recurring /
// salvage / upsell. Snapshots are written per-store + one PORTFOLIO total.
//
// No date-range-level transactions endpoint exists on Solvpath (only
// per-customer history), which is why this is a heavy iteration. Run it
// on-demand, not on every dashboard render.

import {
  listCustomers,
  getTransactionHistory,
  type SolvpathTransaction,
} from "./client";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Solvpath's valid SubscriptionStatus values (confirmed via 400 error):
//   [Active, Canceled, Never Approved, Never Enrolled]
// - Active: currently billing subscribers
// - Canceled: former subscribers — may still show in-window tx from before cancel
// - Never Enrolled: one-time buyers who never subscribed (= Direct sale only)
// - Never Approved: payment rejects — skipped (no revenue anyway)
export const SUBSCRIBER_STATUSES = [
  "Active",
  "Canceled",
  "Never Enrolled",
] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

// Which Solvpath tx.Domain maps to which of our stores. Only these three
// count; any other domain is dropped on the floor.
export const STORE_BY_DOMAIN: Record<string, StoreId> = {
  "try.novasense-usa.store": "NOVA",
  "nuracare.shop": "NURA",
  "kovacare.shop": "KOVA",
};

// Solvpath StoreCode → our store id. Used as the primary cross-store filter
// (more reliable than the Domain string, which may differ between a
// customer's primary store and an actual transaction's store).
export const STORE_BY_CODE: Record<number, StoreId> = {
  1059: "NOVA", // try.novasense-usa.store
  1045: "NURA", // nuracare.shop
  1058: "KOVA", // kovacare.shop
};

export type StoreId = "NOVA" | "NURA" | "KOVA";
export const STORE_IDS: StoreId[] = ["NOVA", "NURA", "KOVA"];

// Normalize a Domain field: strip protocol, trailing slash, leading `www.`
function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function storeFromDomain(domain: string | null | undefined): StoreId | null {
  const key = normalizeDomain(domain);
  return STORE_BY_DOMAIN[key] ?? null;
}

/**
 * Resolve a transaction to one of our stores. Prefers StoreCode (numeric,
 * unambiguous) when present; falls back to Domain string matching. Returns
 * null when the tx belongs to a store we don't track — caller should skip.
 */
export function storeFromTransaction(tx: {
  StoreCode?: number;
  Domain?: string;
}): StoreId | null {
  if (typeof tx.StoreCode === "number" && STORE_BY_CODE[tx.StoreCode]) {
    return STORE_BY_CODE[tx.StoreCode];
  }
  return storeFromDomain(tx.Domain);
}

// ─── Classifier ─────────────────────────────────────────────────────────────
// Five-bucket scheme. Frontend (Direct) vs Subscription (Initial + Recurring
// + Salvage) is a READ-time concern — we store the fine grain here so the
// dashboard can re-bucket later without a re-ingest.

type BucketKey = "direct" | "initial" | "recurring" | "salvage" | "upsell";

export type TxClassification =
  | { bucket: BucketKey; amount: number }
  | { refundOrVoid: true; amount: number }
  | null;

export function classifyTransaction(tx: SolvpathTransaction): TxClassification {
  const raw = Number(tx.Amount ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  // Voids + refunds are tracked separately from the revenue buckets so the
  // dashboard can show net vs gross.
  const ttype = (tx.TransactionType || "").toLowerCase();
  if (ttype.includes("void") || ttype.includes("refund")) {
    return { refundOrVoid: true, amount: raw };
  }

  if (tx.ResponseCode !== "100") return null;

  const type = (tx.Type || "").toLowerCase();
  const isRebill = (tx.RecurringOrderCount ?? 0) > 0;

  // Match on Type first since it's the explicit label; fall back to
  // RecurringOrderCount for rows that left Type blank.
  if (type.includes("salvage")) return { bucket: "salvage", amount: raw };
  if (type.includes("upsell")) return { bucket: "upsell", amount: raw };
  if (type.includes("initial")) return { bucket: "initial", amount: raw };
  if (type.includes("direct")) return { bucket: "direct", amount: raw };
  if (type.includes("recurring") || isRebill) return { bucket: "recurring", amount: raw };

  return null; // unrecognized — caller can log via unknownTypes
}

// ─── Buckets ────────────────────────────────────────────────────────────────

export type RevenueBuckets = {
  direct: number;
  initial: number;
  recurring: number;
  salvage: number;
  upsell: number;
  refundsVoids: number;
  total: number; // direct + initial + recurring + salvage + upsell
  // Counts per bucket — needed so the dashboard can show "Subs Billed"
  // (count of recurring + salvage tx on a given day).
  directCount: number;
  initialCount: number;
  recurringCount: number;
  salvageCount: number;
  upsellCount: number;
  refundsVoidsCount: number;
  transactionsSeen: number;
  unknownTypes: Record<string, number>; // tally unclassified Type strings
};

function emptyBuckets(): RevenueBuckets {
  return {
    direct: 0,
    initial: 0,
    recurring: 0,
    salvage: 0,
    upsell: 0,
    refundsVoids: 0,
    total: 0,
    directCount: 0,
    initialCount: 0,
    recurringCount: 0,
    salvageCount: 0,
    upsellCount: 0,
    refundsVoidsCount: 0,
    transactionsSeen: 0,
    unknownTypes: {},
  };
}

function roundBuckets(b: RevenueBuckets): RevenueBuckets {
  const money = ["direct", "initial", "recurring", "salvage", "upsell", "refundsVoids", "total"] as const;
  for (const k of money) b[k] = Math.round(b[k] * 100) / 100;
  return b;
}

const COUNT_KEY: Record<
  "direct" | "initial" | "recurring" | "salvage" | "upsell",
  | "directCount"
  | "initialCount"
  | "recurringCount"
  | "salvageCount"
  | "upsellCount"
> = {
  direct: "directCount",
  initial: "initialCount",
  recurring: "recurringCount",
  salvage: "salvageCount",
  upsell: "upsellCount",
};

// ─── Chunked Backfill (resume-safe) ─────────────────────────────────────────
// Vercel caps serverless functions at 60s on the Pro plan, so a full 10k-
// customer iteration can't fit in one invocation. Each call processes a
// page-aligned slice [startStatus, startPage) for up to `maxCustomers`
// customers, merges the resulting buckets additively into any existing
// snapshot row for (store_id, range), and returns a cursor for the next
// invocation. A driver script loops until `finished: true`.

// Vercel function cap is effectively 60s on this project (the 800s
// project-level setting hasn't taken effect), so chunks need to fit in
// that budget. PAGE_SIZE=10 gives each chunk ~50s of headroom for both
// the customer iteration and per-day persistence.
const PAGE_SIZE = 10;

export type BackfillOptions = {
  /** Tenant whose phx_summary_snapshots rows are written / overwritten. */
  tenantId: string;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  startStatus?: SubscriberStatus;
  startPage?: number; // 1-based; relative to startStatus
  maxCustomers?: number;
  throttleMs?: number;
  persist?: boolean;
  /** If true, delete existing snapshot rows for (stores + PORTFOLIO, range)
   *  before processing. Use on the first chunk of a fresh backfill. */
  reset?: boolean;
  /** Stop processing and return with a cursor once this many ms have elapsed.
   *  Keeps us under Vercel's 60s function cap regardless of chunk size. */
  deadlineMs?: number;
};

export type BackfillProgress = {
  customersSeen: number;
  customersWithTx: number;
  customersSkippedDup: number;
  finished: boolean;
  nextStatus: SubscriberStatus | null;
  nextPage: number | null;
};

export type BackfillResult = {
  range: { from: string; to: string };
  chunk: {
    startStatus: SubscriberStatus;
    startPage: number;
    maxCustomers: number;
  };
  /** Per-(date, store) buckets for THIS chunk only (cumulative DB state lives
   *  in phx_summary_snapshots after merge). */
  perDayPerStore: Record<string, Record<StoreId, RevenueBuckets>>;
  /** Roll-up of perDayPerStore for quick driver-side display. */
  perStoreTotals: Record<StoreId, RevenueBuckets>;
  progress: BackfillProgress;
  persisted: boolean;
};

type PerDayPerStore = Map<string, Record<StoreId, RevenueBuckets>>;

function ensureDayBuckets(
  m: PerDayPerStore,
  date: string,
): Record<StoreId, RevenueBuckets> {
  let day = m.get(date);
  if (!day) {
    day = { NOVA: emptyBuckets(), NURA: emptyBuckets(), KOVA: emptyBuckets() };
    m.set(date, day);
  }
  return day;
}

export async function backfillRevenueForRange(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const perDayPerStore: PerDayPerStore = new Map();
  // Roll-up across days, returned for driver-side display + meta.
  const perStoreTotals: Record<StoreId, RevenueBuckets> = {
    NOVA: emptyBuckets(),
    NURA: emptyBuckets(),
    KOVA: emptyBuckets(),
  };

  const throttle = opts.throttleMs ?? 150;
  const fromIso = `${opts.from}T00:00:00.000Z`;
  const toIso = `${opts.to}T23:59:59.999Z`;
  const maxCustomers = opts.maxCustomers ?? 500;
  const startStatus: SubscriberStatus = opts.startStatus ?? "Active";
  const startPage = Math.max(1, opts.startPage ?? 1);
  const startedAt = Date.now();
  const deadlineMs = opts.deadlineMs ?? 40_000; // 20s headroom under Vercel 60s cap
  const deadlineHit = () => Date.now() - startedAt >= deadlineMs;

  if (opts.reset) {
    await deleteSnapshotsTouchingRange(opts.from, opts.to, opts.tenantId);
  }

  // Dedupe set persisted across chunks. A customer who appears in multiple
  // status lists (e.g., Active for one store + Canceled for another) would
  // otherwise have their tx-history fetched + bucketed twice, doubling
  // subscription revenue.
  const seenCustomers = await loadSeenCustomers(
    opts.from,
    opts.to,
    opts.tenantId,
  );
  const newlySeen = new Set<number>();

  let customersSeen = 0;
  let customersWithTx = 0;
  let customersSkippedDup = 0;
  let finished = false;
  let nextStatus: SubscriberStatus | null = null;
  let nextPage: number | null = null;

  const statusIdx = SUBSCRIBER_STATUSES.indexOf(startStatus);
  if (statusIdx < 0) throw new Error(`unknown startStatus: ${startStatus}`);

  outer: for (let si = statusIdx; si < SUBSCRIBER_STATUSES.length; si++) {
    const status = SUBSCRIBER_STATUSES[si];
    // First status begins at startPage; subsequent statuses always start at 1.
    let page = si === statusIdx ? startPage : 1;

    while (true) {
      // Check deadline BEFORE starting a new page (except the first page of
      // the chunk — we always make some progress). Pages are atomic: once we
      // start iterating customers in a page, we finish the page before
      // checking the deadline, so the cursor always lands on a page boundary
      // and we never double-count under merge-additive persistence.
      if (customersSeen > 0 && deadlineHit()) {
        nextStatus = status;
        nextPage = page;
        break outer;
      }

      const resp = await listCustomers(opts.tenantId, {
        Page: page,
        Limit: PAGE_SIZE,
        SubscriptionStatus: status,
      });
      const customers = resp.Result ?? [];

      for (const cust of customers) {
        customersSeen += 1;

        // Skip if we already pulled this customer's history in an earlier
        // chunk / under a different status list.
        if (seenCustomers.has(cust.CustomerId)) {
          customersSkippedDup += 1;
          continue;
        }
        seenCustomers.add(cust.CustomerId);
        newlySeen.add(cust.CustomerId);

        let history: { Result: SolvpathTransaction[] };
        try {
          history = await getTransactionHistory(opts.tenantId, cust.CustomerId, opts.from);
        } catch {
          continue;
        }

        const rows = history.Result ?? [];
        if (rows.length > 0) customersWithTx += 1;

        // Per-customer OrderId dedupe: Solvpath's /transaction-history can
        // return the same OrderId multiple times (mirrored across the
        // customer's subscription rows). March came in at $137k vs PHX's
        // $79k with our customer-level dedupe — counts of Initial and
        // Recurring were ~2x at the per-tx level, indicating each tx was
        // returned twice. Skip second+ occurrences.
        const seenOrderIds = new Set<number>();

        for (const tx of rows) {
          if (!tx.Date) continue;
          if (tx.Date < fromIso || tx.Date > toIso) continue;

          if (typeof tx.OrderId === "number") {
            if (seenOrderIds.has(tx.OrderId)) continue;
            seenOrderIds.add(tx.OrderId);
          }

          const store = storeFromTransaction(tx);
          if (!store) continue;

          const txDate = tx.Date.slice(0, 10); // YYYY-MM-DD
          const dayBuckets = ensureDayBuckets(perDayPerStore, txDate);
          const dayStore = dayBuckets[store];
          const totalStore = perStoreTotals[store];

          const cls = classifyTransaction(tx);
          if (!cls) {
            const key = (tx.Type || "(blank)").trim();
            const amt = Number(tx.Amount ?? 0);
            dayStore.unknownTypes[key] = (dayStore.unknownTypes[key] ?? 0) + amt;
            totalStore.unknownTypes[key] =
              (totalStore.unknownTypes[key] ?? 0) + amt;
            continue;
          }

          dayStore.transactionsSeen += 1;
          totalStore.transactionsSeen += 1;

          if ("refundOrVoid" in cls) {
            dayStore.refundsVoids += cls.amount;
            dayStore.refundsVoidsCount += 1;
            totalStore.refundsVoids += cls.amount;
            totalStore.refundsVoidsCount += 1;
            continue;
          }
          dayStore[cls.bucket] += cls.amount;
          dayStore[COUNT_KEY[cls.bucket]] += 1;
          totalStore[cls.bucket] += cls.amount;
          totalStore[COUNT_KEY[cls.bucket]] += 1;
        }

        if (throttle > 0) await new Promise((r) => setTimeout(r, throttle));
      }

      // End-of-page decisions. We only stop on page boundaries so the cursor
      // stays simple (status + page).
      const pagesCovered = page * PAGE_SIZE;
      const morePages = customers.length > 0 && pagesCovered < resp.TotalCount;

      if (customersSeen >= maxCustomers) {
        if (morePages) {
          nextStatus = status;
          nextPage = page + 1;
        } else if (si + 1 < SUBSCRIBER_STATUSES.length) {
          nextStatus = SUBSCRIBER_STATUSES[si + 1];
          nextPage = 1;
        } else {
          finished = true;
        }
        break outer;
      }

      if (!morePages) break; // advance to next status
      page += 1;
    }
  }

  if (nextStatus === null && nextPage === null) finished = true;

  // Totals + rounding for each day's per-store buckets.
  for (const dayBuckets of perDayPerStore.values()) {
    for (const s of STORE_IDS) {
      const b = dayBuckets[s];
      b.total = b.direct + b.initial + b.recurring + b.salvage + b.upsell;
      roundBuckets(b);
    }
  }
  // Roll-up totals (used in the response, not persisted).
  for (const s of STORE_IDS) {
    const b = perStoreTotals[s];
    b.total = b.direct + b.initial + b.recurring + b.salvage + b.upsell;
    roundBuckets(b);
  }

  let persisted = false;
  if (opts.persist !== false && customersSeen > 0) {
    persisted = await mergePerDaySnapshots(
      perDayPerStore,
      { customersSeen, customersWithTx },
      opts.tenantId,
    );
    // Update dedupe marker AFTER successful per-day persist. If both succeed,
    // resuming after a crash either reprocesses an unmarked customer (safe —
    // their day-row already has their values, but we'd add again — small
    // risk window) OR sees them as already-seen and skips.
    if (newlySeen.size > 0) {
      await persistSeenCustomers(
        opts.from,
        opts.to,
        seenCustomers,
        opts.tenantId,
      );
    }
  }

  // Convert Map to plain object for the JSON response.
  const perDayObj: Record<string, Record<StoreId, RevenueBuckets>> = {};
  for (const [d, v] of perDayPerStore) perDayObj[d] = v;

  return {
    range: { from: opts.from, to: opts.to },
    chunk: { startStatus, startPage, maxCustomers },
    perDayPerStore: perDayObj,
    perStoreTotals,
    progress: {
      customersSeen,
      customersWithTx,
      customersSkippedDup,
      finished,
      nextStatus,
      nextPage,
    },
    persisted,
  };
}

/**
 * Wipe any phx_summary_snapshots rows that overlap the given window. Used
 * by reset=1 to clean BOTH old per-period rows (range spans multiple days)
 * AND prior per-day rows for the same window before a fresh ingest. Also
 * clears the customer-dedupe tracking row.
 */
async function deleteSnapshotsTouchingRange(
  from: string,
  to: string,
  tenantId: string,
): Promise<void> {
  const sb = supabaseAdmin();
  const ids: Array<StoreId | "PORTFOLIO"> = [...STORE_IDS, "PORTFOLIO"];
  const { error } = await sb
    .from("phx_summary_snapshots")
    .delete()
    .eq("tenant_id", tenantId)
    .in("store_id", ids)
    .lte("range_from", to)
    .gte("range_to", from);
  if (error)
    throw new Error(`deleteSnapshotsTouchingRange: ${error.message}`);
  // Also wipe the dedupe marker for this window.
  await sb
    .from("phx_summary_snapshots")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("store_id", BACKFILL_DEDUPE_STORE_ID)
    .eq("range_from", from)
    .eq("range_to", to);
}

// Marker row in phx_summary_snapshots whose raw_json carries the list of
// CustomerIds we've already pulled transaction history for in this run.
// Some Solvpath customers appear in multiple status lists (Active +
// Canceled if they have both states across stores), and re-fetching their
// history would double-count subscription buckets.
const BACKFILL_DEDUPE_STORE_ID = "__BACKFILL_DEDUPE__";

async function loadSeenCustomers(
  from: string,
  to: string,
  tenantId: string,
): Promise<Set<number>> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("phx_summary_snapshots")
    .select("raw_json")
    .eq("tenant_id", tenantId)
    .eq("store_id", BACKFILL_DEDUPE_STORE_ID)
    .eq("range_from", from)
    .eq("range_to", to)
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows; anything else is real
    throw new Error(`loadSeenCustomers: ${error.message}`);
  }
  const ids = (data?.raw_json as { customerIds?: number[] } | null)?.customerIds ?? [];
  return new Set(ids);
}

async function persistSeenCustomers(
  from: string,
  to: string,
  ids: Set<number>,
  tenantId: string,
): Promise<void> {
  if (ids.size === 0) return;
  const sb = supabaseAdmin();
  const now = new Date();
  const { error } = await sb.from("phx_summary_snapshots").upsert(
    {
      tenant_id: tenantId,
      store_id: BACKFILL_DEDUPE_STORE_ID,
      range_from: from,
      range_to: to,
      scrape_date: now.toISOString().slice(0, 10),
      scraped_at: now.toISOString(),
      raw_json: { customerIds: [...ids].sort((a, b) => a - b) },
    },
    { onConflict: "store_id,range_from,range_to" },
  );
  if (error) throw new Error(`persistSeenCustomers: ${error.message}`);
}

type SnapshotRow = {
  store_id: string;
  range_from: string;
  range_to: string;
  revenue_direct: number | null;
  revenue_initial: number | null;
  revenue_recurring: number | null;
  revenue_salvage: number | null;
  revenue_upsell: number | null;
  revenue_total: number | null;
  raw_json: Record<string, unknown> | null;
};

/**
 * Additively merge per-day per-store buckets into phx_summary_snapshots.
 * One row per (store, date) is upserted with range_from = range_to = date.
 * Per-bucket counts and refund tally live in raw_json (no schema change).
 */
async function mergePerDaySnapshots(
  perDayPerStore: PerDayPerStore,
  meta: { customersSeen: number; customersWithTx: number },
  tenantId: string,
): Promise<boolean> {
  if (perDayPerStore.size === 0) return false;

  // Collect (store, date) keys with any signal.
  const keys: Array<{ store: StoreId; date: string }> = [];
  for (const [date, byStore] of perDayPerStore) {
    for (const s of STORE_IDS) {
      const b = byStore[s];
      if (
        b.total > 0 ||
        b.refundsVoids > 0 ||
        b.transactionsSeen > 0 ||
        Object.keys(b.unknownTypes).length > 0
      ) {
        keys.push({ store: s, date });
      }
    }
  }
  if (keys.length === 0) return false;

  const dates = [...new Set(keys.map((k) => k.date))];
  const sb = supabaseAdmin();

  // Read existing rows for those (store, date) keys. Over-fetch on date and
  // filter to per-day (range_from = range_to) in JS.
  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  const { data: existingRows, error: readErr } = await sb
    .from("phx_summary_snapshots")
    .select(
      "store_id, range_from, range_to, revenue_direct, revenue_initial, revenue_recurring, revenue_salvage, revenue_upsell, revenue_total, raw_json",
    )
    .eq("tenant_id", tenantId)
    .in("store_id", STORE_IDS)
    .gte("range_from", minDate)
    .lte("range_to", maxDate);
  if (readErr) throw new Error(`read per-day snapshots: ${readErr.message}`);
  const byKey = new Map<string, SnapshotRow>();
  for (const r of (existingRows as SnapshotRow[]) ?? []) {
    if (r.range_from !== r.range_to) continue; // skip period rows
    byKey.set(`${r.store_id}|${r.range_from}`, r);
  }

  const now = new Date();
  const scrape_date = now.toISOString().slice(0, 10);
  const scraped_at = now.toISOString();

  const rows = keys.map(({ store, date }) => ({
    ...mergeDayRow(
      byKey.get(`${store}|${date}`),
      store,
      date,
      scrape_date,
      scraped_at,
      perDayPerStore.get(date)![store],
      meta,
    ),
    tenant_id: tenantId,
  }));

  const { error } = await sb
    .from("phx_summary_snapshots")
    .upsert(rows, { onConflict: "store_id,range_from,range_to" });
  if (error) throw new Error(`per-day snapshot upsert: ${error.message}`);
  return true;
}

type DayJson = {
  source?: string;
  refundsVoids?: number;
  refundsVoidsCount?: number;
  transactionsSeen?: number;
  unknownTypes?: Record<string, number>;
  directCount?: number;
  initialCount?: number;
  recurringCount?: number;
  salvageCount?: number;
  upsellCount?: number;
  customersSeen?: number;
  customersWithTx?: number;
};

function mergeDayRow(
  existing: SnapshotRow | undefined,
  store_id: StoreId,
  date: string,
  scrape_date: string,
  scraped_at: string,
  chunk: RevenueBuckets,
  meta: { customersSeen: number; customersWithTx: number },
) {
  const add = (prev: number | null | undefined, next: number): number =>
    Math.round(((Number(prev) || 0) + next) * 100) / 100;

  const prevJson = (existing?.raw_json as DayJson | null) ?? null;
  const mergedUnknown: Record<string, number> = {
    ...(prevJson?.unknownTypes ?? {}),
  };
  for (const [k, v] of Object.entries(chunk.unknownTypes)) {
    mergedUnknown[k] = Math.round(((mergedUnknown[k] ?? 0) + v) * 100) / 100;
  }

  return {
    store_id,
    range_from: date,
    range_to: date,
    scrape_date,
    scraped_at,
    revenue_direct: add(existing?.revenue_direct, chunk.direct),
    revenue_initial: add(existing?.revenue_initial, chunk.initial),
    revenue_recurring: add(existing?.revenue_recurring, chunk.recurring),
    revenue_salvage: add(existing?.revenue_salvage, chunk.salvage),
    revenue_upsell: add(existing?.revenue_upsell, chunk.upsell),
    revenue_total: add(existing?.revenue_total, chunk.total),
    raw_json: {
      source: "solvpath.backfillRevenueForRange",
      refundsVoids: add(prevJson?.refundsVoids, chunk.refundsVoids),
      refundsVoidsCount:
        (prevJson?.refundsVoidsCount ?? 0) + chunk.refundsVoidsCount,
      transactionsSeen:
        (prevJson?.transactionsSeen ?? 0) + chunk.transactionsSeen,
      unknownTypes: mergedUnknown,
      directCount: (prevJson?.directCount ?? 0) + chunk.directCount,
      initialCount: (prevJson?.initialCount ?? 0) + chunk.initialCount,
      recurringCount: (prevJson?.recurringCount ?? 0) + chunk.recurringCount,
      salvageCount: (prevJson?.salvageCount ?? 0) + chunk.salvageCount,
      upsellCount: (prevJson?.upsellCount ?? 0) + chunk.upsellCount,
      customersSeen: (prevJson?.customersSeen ?? 0) + meta.customersSeen,
      customersWithTx: (prevJson?.customersWithTx ?? 0) + meta.customersWithTx,
    },
  };
}

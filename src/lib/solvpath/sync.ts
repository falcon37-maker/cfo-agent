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

// One-time "Direct" buyers who never subscribe still appear under "Active"
// or similar — we pull all subscription statuses to be safe.
export const SUBSCRIBER_STATUSES = ["Active", "Cancelled", "Paused"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

// Which Solvpath tx.Domain maps to which of our stores. Only these three
// count; any other domain is dropped on the floor.
export const STORE_BY_DOMAIN: Record<string, StoreId> = {
  "try.novasense-usa.store": "NOVA",
  "nuracare.shop": "NURA",
  "kovacare.shop": "KOVA",
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
    transactionsSeen: 0,
    unknownTypes: {},
  };
}

function roundBuckets(b: RevenueBuckets): RevenueBuckets {
  const money = ["direct", "initial", "recurring", "salvage", "upsell", "refundsVoids", "total"] as const;
  for (const k of money) b[k] = Math.round(b[k] * 100) / 100;
  return b;
}

// ─── Chunked Backfill (resume-safe) ─────────────────────────────────────────
// Vercel caps serverless functions at 60s on the Pro plan, so a full 10k-
// customer iteration can't fit in one invocation. Each call processes a
// page-aligned slice [startStatus, startPage) for up to `maxCustomers`
// customers, merges the resulting buckets additively into any existing
// snapshot row for (store_id, range), and returns a cursor for the next
// invocation. A driver script loops until `finished: true`.

// Small pages (vs Solvpath's 250-max) so a page's customer iteration fits
// well within Vercel's 60s function cap even when some getTransactionHistory
// calls hit 429 and eat 15s each of retry backoff.
const PAGE_SIZE = 50;

export type BackfillOptions = {
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
  perStore: Record<StoreId, RevenueBuckets>;
  portfolio: RevenueBuckets;
  progress: BackfillProgress;
  persisted: boolean;
};

export async function backfillRevenueForRange(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const perStore: Record<StoreId, RevenueBuckets> = {
    NOVA: emptyBuckets(),
    NURA: emptyBuckets(),
    KOVA: emptyBuckets(),
  };
  const portfolio = emptyBuckets();

  const throttle = opts.throttleMs ?? 150;
  const fromIso = `${opts.from}T00:00:00.000Z`;
  const toIso = `${opts.to}T23:59:59.999Z`;
  const maxCustomers = opts.maxCustomers ?? 500;
  const startStatus: SubscriberStatus = opts.startStatus ?? "Active";
  const startPage = Math.max(1, opts.startPage ?? 1);
  const startedAt = Date.now();
  const deadlineMs = opts.deadlineMs ?? 50_000; // leave ~10s headroom under Vercel 60s
  const deadlineHit = () => Date.now() - startedAt >= deadlineMs;

  if (opts.reset) {
    await deleteSnapshotsForRange(opts.from, opts.to);
  }

  let customersSeen = 0;
  let customersWithTx = 0;
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

      const resp = await listCustomers({
        Page: page,
        Limit: PAGE_SIZE,
        SubscriptionStatus: status,
      });
      const customers = resp.Result ?? [];

      for (const cust of customers) {
        customersSeen += 1;

        let history: { Result: SolvpathTransaction[] };
        try {
          history = await getTransactionHistory(cust.CustomerId, opts.from);
        } catch {
          continue;
        }

        const rows = history.Result ?? [];
        if (rows.length > 0) customersWithTx += 1;

        for (const tx of rows) {
          if (!tx.Date) continue;
          if (tx.Date < fromIso || tx.Date > toIso) continue;

          const store = storeFromDomain(tx.Domain);
          if (!store) continue;

          const cls = classifyTransaction(tx);
          if (!cls) {
            const key = (tx.Type || "(blank)").trim();
            perStore[store].unknownTypes[key] =
              (perStore[store].unknownTypes[key] ?? 0) + Number(tx.Amount ?? 0);
            portfolio.unknownTypes[key] =
              (portfolio.unknownTypes[key] ?? 0) + Number(tx.Amount ?? 0);
            continue;
          }

          perStore[store].transactionsSeen += 1;
          portfolio.transactionsSeen += 1;

          if ("refundOrVoid" in cls) {
            perStore[store].refundsVoids += cls.amount;
            portfolio.refundsVoids += cls.amount;
            continue;
          }
          perStore[store][cls.bucket] += cls.amount;
          portfolio[cls.bucket] += cls.amount;
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

  // Totals + rounding.
  for (const s of STORE_IDS) {
    const b = perStore[s];
    b.total = b.direct + b.initial + b.recurring + b.salvage + b.upsell;
    roundBuckets(b);
  }
  portfolio.total =
    portfolio.direct +
    portfolio.initial +
    portfolio.recurring +
    portfolio.salvage +
    portfolio.upsell;
  roundBuckets(portfolio);

  let persisted = false;
  if (opts.persist !== false && customersSeen > 0) {
    persisted = await mergeSnapshots(opts.from, opts.to, perStore, portfolio, {
      customersSeen,
      customersWithTx,
    });
  }

  return {
    range: { from: opts.from, to: opts.to },
    chunk: { startStatus, startPage, maxCustomers },
    perStore,
    portfolio,
    progress: {
      customersSeen,
      customersWithTx,
      finished,
      nextStatus,
      nextPage,
    },
    persisted,
  };
}

async function deleteSnapshotsForRange(from: string, to: string): Promise<void> {
  const sb = supabaseAdmin();
  const ids: Array<StoreId | "PORTFOLIO"> = [...STORE_IDS, "PORTFOLIO"];
  const { error } = await sb
    .from("phx_summary_snapshots")
    .delete()
    .in("store_id", ids)
    .eq("range_from", from)
    .eq("range_to", to);
  if (error) throw new Error(`deleteSnapshotsForRange: ${error.message}`);
}

type SnapshotRow = {
  store_id: string;
  revenue_direct: number | null;
  revenue_initial: number | null;
  revenue_recurring: number | null;
  revenue_salvage: number | null;
  revenue_upsell: number | null;
  revenue_total: number | null;
  raw_json: Record<string, unknown> | null;
};

/**
 * Additively merge this chunk's buckets into the existing snapshot row for
 * each (store, range) — so consecutive invocations accumulate instead of
 * overwriting. raw_json.unknownTypes is union-summed too.
 */
async function mergeSnapshots(
  from: string,
  to: string,
  perStore: Record<StoreId, RevenueBuckets>,
  portfolio: RevenueBuckets,
  meta: { customersSeen: number; customersWithTx: number },
): Promise<boolean> {
  const sb = supabaseAdmin();
  const ids: Array<StoreId | "PORTFOLIO"> = [...STORE_IDS, "PORTFOLIO"];

  const { data: existingRows, error: readErr } = await sb
    .from("phx_summary_snapshots")
    .select(
      "store_id, revenue_direct, revenue_initial, revenue_recurring, revenue_salvage, revenue_upsell, revenue_total, raw_json",
    )
    .in("store_id", ids)
    .eq("range_from", from)
    .eq("range_to", to);
  if (readErr) throw new Error(`read existing snapshots: ${readErr.message}`);
  const byStore = new Map<string, SnapshotRow>();
  for (const r of existingRows ?? []) byStore.set(r.store_id, r as SnapshotRow);

  const now = new Date();
  const scrape_date = now.toISOString().slice(0, 10);
  const scraped_at = now.toISOString();

  const rows = [
    ...STORE_IDS.map((s) =>
      mergeRow(byStore.get(s), s, from, to, scrape_date, scraped_at, perStore[s], meta),
    ),
    mergeRow(byStore.get("PORTFOLIO"), "PORTFOLIO", from, to, scrape_date, scraped_at, portfolio, meta),
  ];

  const { error } = await sb
    .from("phx_summary_snapshots")
    .upsert(rows, { onConflict: "store_id,range_from,range_to" });
  if (error) throw new Error(`snapshot upsert: ${error.message}`);
  return true;
}

function mergeRow(
  existing: SnapshotRow | undefined,
  store_id: string,
  from: string,
  to: string,
  scrape_date: string,
  scraped_at: string,
  chunk: RevenueBuckets,
  meta: { customersSeen: number; customersWithTx: number },
) {
  const add = (prev: number | null | undefined, next: number): number =>
    Math.round(((Number(prev) || 0) + next) * 100) / 100;

  const prevJson = (existing?.raw_json as {
    refundsVoids?: number;
    transactionsSeen?: number;
    unknownTypes?: Record<string, number>;
    customersSeen?: number;
    customersWithTx?: number;
  } | null) ?? null;

  const mergedUnknown: Record<string, number> = { ...(prevJson?.unknownTypes ?? {}) };
  for (const [k, v] of Object.entries(chunk.unknownTypes)) {
    mergedUnknown[k] = Math.round(((mergedUnknown[k] ?? 0) + v) * 100) / 100;
  }

  return {
    store_id,
    range_from: from,
    range_to: to,
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
      transactionsSeen:
        (prevJson?.transactionsSeen ?? 0) + chunk.transactionsSeen,
      unknownTypes: mergedUnknown,
      customersSeen: (prevJson?.customersSeen ?? 0) + meta.customersSeen,
      customersWithTx: (prevJson?.customersWithTx ?? 0) + meta.customersWithTx,
    },
  };
}

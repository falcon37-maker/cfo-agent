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
  iterateCustomers,
  getTransactionHistory,
  type SolvpathTransaction,
} from "./client";
import { supabaseAdmin } from "@/lib/supabase/admin";

// One-time "Direct" buyers who never subscribe still appear under "Active"
// or similar — we pull all subscription statuses to be safe. If we later
// need speed, the biggest win is a StoreCode filter if Solvpath supports it.
const SUBSCRIBER_STATUSES = ["Active", "Cancelled", "Paused"];

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

// ─── Backfill ───────────────────────────────────────────────────────────────

export type BackfillOptions = {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  customerLimit?: number;
  throttleMs?: number;
  persist?: boolean;
};

export type BackfillResult = {
  range: { from: string; to: string };
  perStore: Record<StoreId, RevenueBuckets>;
  portfolio: RevenueBuckets;
  customersSeen: number;
  customersWithTx: number;
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

  const throttle = opts.throttleMs ?? 200;
  const fromIso = `${opts.from}T00:00:00.000Z`;
  const toIso = `${opts.to}T23:59:59.999Z`;
  let customersSeen = 0;
  let customersWithTx = 0;

  outer: for (const status of SUBSCRIBER_STATUSES) {
    for await (const cust of iterateCustomers(status)) {
      customersSeen += 1;
      if (opts.customerLimit && customersSeen > opts.customerLimit) break outer;

      let history: { Result: SolvpathTransaction[] };
      try {
        history = await getTransactionHistory(cust.CustomerId, opts.from);
      } catch {
        continue; // one bad customer shouldn't kill the batch
      }

      const rows = history.Result ?? [];
      if (rows.length > 0) customersWithTx += 1;

      for (const tx of rows) {
        if (!tx.Date) continue;
        if (tx.Date < fromIso || tx.Date > toIso) continue;

        const store = storeFromDomain(tx.Domain);
        if (!store) continue; // not one of our 3 stores

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
  }

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
  if (opts.persist !== false) {
    persisted = await persistSnapshots(opts.from, opts.to, perStore, portfolio, {
      customersSeen,
      customersWithTx,
    });
  }

  return {
    range: { from: opts.from, to: opts.to },
    perStore,
    portfolio,
    customersSeen,
    customersWithTx,
    persisted,
  };
}

async function persistSnapshots(
  from: string,
  to: string,
  perStore: Record<StoreId, RevenueBuckets>,
  portfolio: RevenueBuckets,
  meta: { customersSeen: number; customersWithTx: number },
): Promise<boolean> {
  const sb = supabaseAdmin();
  const now = new Date();
  const scrape_date = now.toISOString().slice(0, 10);
  const scraped_at = now.toISOString();

  const rows: Array<{
    store_id: StoreId | "PORTFOLIO";
    buckets: RevenueBuckets;
  }> = [
    ...STORE_IDS.map((s) => ({ store_id: s, buckets: perStore[s] })),
    { store_id: "PORTFOLIO", buckets: portfolio },
  ];

  const upserts = rows.map(({ store_id, buckets }) => ({
    store_id,
    range_from: from,
    range_to: to,
    scrape_date,
    scraped_at,
    revenue_direct: buckets.direct,
    revenue_initial: buckets.initial,
    revenue_recurring: buckets.recurring,
    revenue_salvage: buckets.salvage,
    revenue_upsell: buckets.upsell,
    revenue_total: buckets.total,
    raw_json: {
      source: "solvpath.backfillRevenueForRange",
      refundsVoids: buckets.refundsVoids,
      transactionsSeen: buckets.transactionsSeen,
      unknownTypes: buckets.unknownTypes,
      customersSeen: meta.customersSeen,
      customersWithTx: meta.customersWithTx,
    },
  }));

  const { error } = await sb
    .from("phx_summary_snapshots")
    .upsert(upserts, { onConflict: "store_id,range_from,range_to" });
  if (error) throw new Error(`snapshot upsert: ${error.message}`);
  return true;
}

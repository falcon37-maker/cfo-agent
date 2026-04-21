// Solvpath → phx_summary_snapshots backfill.
//
// For a given [from, to] window, iterate every active/cancelled/paused
// customer, pull their transaction history since `from`, filter to the
// window, bucket amounts by transaction Type, and upsert monthly totals
// back onto phx_summary_snapshots as revenue_recurring / revenue_salvage /
// revenue_upsell / revenue_total.
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

// Statuses we pull — one-time "Direct" buyers with no subscription never
// generate rebill revenue so we skip them to cut the iteration in ~half.
const SUBSCRIBER_STATUSES = ["Active", "Cancelled", "Paused"];

export type RevenueBuckets = {
  recurring: number;
  salvage: number;
  upsell: number;
  other: number; // anything we didn't recognize — surfaces as a warning
  refundsVoids: number; // subtracted from totals for the report
  total: number;
  transactionsSeen: number;
  customersSeen: number;
  customersWithTx: number;
  unknownTypes: Record<string, number>; // tally by unclassified `Type`
};

type BucketKey = "recurring" | "salvage" | "upsell" | "other";

/** Classify a single transaction into a revenue bucket, or null to skip. */
export function classifyTransaction(
  tx: SolvpathTransaction,
): { bucket: BucketKey; amount: number } | { refundOrVoid: true; amount: number } | null {
  // Only successful transactions count as revenue. ResponseCode "100" = success.
  // Voids and refunds reference the original transaction; we track them
  // separately so net totals are accurate.
  const raw = Number(tx.Amount ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const ttype = (tx.TransactionType || "").toLowerCase();
  if (ttype.includes("void") || ttype.includes("refund")) {
    return { refundOrVoid: true, amount: raw };
  }

  if (tx.ResponseCode !== "100") return null;

  const type = (tx.Type || "").toLowerCase();
  const isRebill = (tx.RecurringOrderCount ?? 0) > 0;

  if (isRebill) {
    // Phoenix treats "Salvage" as a sub-kind of recurring in some flows;
    // prefer the explicit Type label when present.
    if (type.includes("salvage")) return { bucket: "salvage", amount: raw };
    return { bucket: "recurring", amount: raw };
  }

  if (type.includes("salvage")) return { bucket: "salvage", amount: raw };
  if (type.includes("upsell")) return { bucket: "upsell", amount: raw };
  if (type.includes("direct") || type.includes("initial")) return null; // Shopify has it

  return { bucket: "other", amount: raw };
}

export type BackfillOptions = {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD (inclusive)
  /** Cap the customer iteration (useful for smoke tests). */
  customerLimit?: number;
  /** Between-customer delay in ms to avoid rate limits. Default 50ms. */
  throttleMs?: number;
  /** If true, also upsert into phx_summary_snapshots. Defaults true. */
  persist?: boolean;
};

export async function backfillRevenueForRange(
  opts: BackfillOptions,
): Promise<RevenueBuckets & { persisted: boolean }> {
  const buckets: RevenueBuckets = {
    recurring: 0,
    salvage: 0,
    upsell: 0,
    other: 0,
    refundsVoids: 0,
    total: 0,
    transactionsSeen: 0,
    customersSeen: 0,
    customersWithTx: 0,
    unknownTypes: {},
  };

  const throttle = opts.throttleMs ?? 50;
  const fromIso = `${opts.from}T00:00:00.000Z`;
  const toIso = `${opts.to}T23:59:59.999Z`;

  for (const status of SUBSCRIBER_STATUSES) {
    for await (const cust of iterateCustomers(status)) {
      buckets.customersSeen += 1;
      if (opts.customerLimit && buckets.customersSeen > opts.customerLimit) break;

      let history: { Result: SolvpathTransaction[] };
      try {
        history = await getTransactionHistory(cust.CustomerId, opts.from);
      } catch {
        // Skip a single customer's failure — keep the batch going.
        continue;
      }

      const rows = history.Result ?? [];
      if (rows.length > 0) buckets.customersWithTx += 1;

      for (const tx of rows) {
        // Filter to window (the API returns everything from StartDateTime onward).
        if (!tx.Date) continue;
        if (tx.Date < fromIso || tx.Date > toIso) continue;

        buckets.transactionsSeen += 1;
        const cls = classifyTransaction(tx);
        if (!cls) continue;
        if ("refundOrVoid" in cls) {
          buckets.refundsVoids += cls.amount;
          continue;
        }
        buckets[cls.bucket] += cls.amount;
        if (cls.bucket === "other") {
          const key = (tx.Type || "(blank)").trim();
          buckets.unknownTypes[key] = (buckets.unknownTypes[key] ?? 0) + cls.amount;
        }
      }

      if (throttle > 0) await new Promise((r) => setTimeout(r, throttle));
    }
    if (opts.customerLimit && buckets.customersSeen > opts.customerLimit) break;
  }

  buckets.total =
    buckets.recurring + buckets.salvage + buckets.upsell + buckets.other;

  // Round all money fields to 2dp before persisting.
  for (const k of ["recurring", "salvage", "upsell", "other", "refundsVoids", "total"] as const) {
    buckets[k] = Math.round(buckets[k] * 100) / 100;
  }

  let persisted = false;
  if (opts.persist !== false) {
    const sb = supabaseAdmin();
    const { error } = await sb
      .from("phx_summary_snapshots")
      .upsert(
        {
          store_id: "PORTFOLIO",
          range_from: opts.from,
          range_to: opts.to,
          scrape_date: new Date().toISOString().slice(0, 10),
          scraped_at: new Date().toISOString(),
          revenue_recurring: buckets.recurring,
          revenue_salvage: buckets.salvage,
          revenue_upsell: buckets.upsell,
          revenue_total: buckets.total,
          raw_json: {
            source: "solvpath.backfillRevenueForRange",
            unknownTypes: buckets.unknownTypes,
            refundsVoids: buckets.refundsVoids,
            transactionsSeen: buckets.transactionsSeen,
            customersSeen: buckets.customersSeen,
            customersWithTx: buckets.customersWithTx,
          },
        },
        { onConflict: "store_id,range_from,range_to" },
      );
    if (error) throw new Error(`snapshot upsert: ${error.message}`);
    persisted = true;
  }

  return { ...buckets, persisted };
}

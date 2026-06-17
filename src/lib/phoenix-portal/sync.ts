// Phoenix Portal → phx_summary_snapshots sync (capture-only, bulk API).
//
// Replaces the legacy per-customer transaction-history walk. For each day we
// pull the full transaction list from the portal and bucket the SETTLED
// captures per store. Billing definition (client spec Jun 2026):
//   billed = TransactionType in {Capture, Direct Sale} AND not FailedTransaction
// Pre-Auth authorizations do NOT count (salvage is Pre-Auth only, so it lands
// at 0 unless/until it captures). This matches Phoenix's "Capture" filter and
// the CSV export exactly (e.g. Jun 12 = 177 / $5,308.23).

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  fetchDayTransactions,
  portalStoreFromDomain,
  type PortalTxn,
} from "./client";

type Bucket = "initial" | "recurring" | "salvage" | "direct" | "upsell";

function bucketOf(type: string | null | undefined): Bucket | null {
  const t = (type || "").toLowerCase();
  if (t.includes("salvage")) return "salvage";
  if (t.includes("initial")) return "initial";
  if (/\b\d+\s*month\b/.test(t)) return "recurring";
  if (t.includes("upsell")) return "upsell";
  if (t.includes("direct")) return "direct";
  return null;
}

/** A charge is BILLED only when it settles: a non-failed Capture/Direct Sale. */
function isBilled(tx: PortalTxn): boolean {
  if (tx.FailedTransaction) return false;
  return tx.TransactionType === "Capture" || tx.TransactionType === "Direct Sale";
}

type StoreBuckets = {
  initial: number;
  recurring: number;
  salvage: number;
  direct: number;
  upsell: number;
  initialCount: number;
  recurringCount: number;
  salvageCount: number;
  directCount: number;
  upsellCount: number;
};

function emptyBuckets(): StoreBuckets {
  return {
    initial: 0,
    recurring: 0,
    salvage: 0,
    direct: 0,
    upsell: 0,
    initialCount: 0,
    recurringCount: 0,
    salvageCount: 0,
    directCount: 0,
    upsellCount: 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const STORES = ["NOVA", "NURA", "KOVA"] as const;

export type PortalDayResult = {
  day: string;
  rowsUpserted: number;
  totalBilledCount: number;
  totalBilledRevenue: number;
};

/**
 * Sync one day of Phoenix subscription billing into phx_summary_snapshots
 * (one row per store). Capture-only. Idempotent: re-running rewrites the day.
 */
export async function syncPhoenixPortalDay(
  tenantId: string,
  day: string,
): Promise<PortalDayResult> {
  const rows = await fetchDayTransactions(tenantId, day);

  const stores: Record<string, StoreBuckets> = {
    NOVA: emptyBuckets(),
    NURA: emptyBuckets(),
    KOVA: emptyBuckets(),
  };

  for (const tx of rows) {
    if (!isBilled(tx)) continue;
    const bucket = bucketOf(tx.Type);
    if (!bucket) continue;
    const store = portalStoreFromDomain(tx.Domain);
    if (!store || !(store in stores)) continue;
    const amt = Number(tx.Amount) || 0;
    stores[store][bucket] += amt;
    stores[store][`${bucket}Count` as keyof StoreBuckets] += 1;
  }

  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  const snapshotRows = STORES.map((store) => {
    const b = stores[store];
    const total = round2(b.initial + b.recurring + b.salvage + b.direct + b.upsell);
    return {
      tenant_id: tenantId,
      store_id: store,
      range_from: day,
      range_to: day,
      scrape_date: day,
      scraped_at: now,
      revenue_initial: round2(b.initial),
      revenue_recurring: round2(b.recurring),
      revenue_salvage: round2(b.salvage),
      revenue_direct: round2(b.direct),
      revenue_upsell: round2(b.upsell),
      revenue_total: total,
      initial_subscription_count: b.initialCount,
      recurring_subscription_count: b.recurringCount,
      subscription_salvage_count: b.salvageCount,
      direct_sale_count: b.directCount,
      upsell_count: b.upsellCount,
      raw_json: {
        source: "phoenix.portal.capture_only",
        day,
        store,
        initialCount: b.initialCount,
        recurringCount: b.recurringCount,
        salvageCount: b.salvageCount,
        directCount: b.directCount,
        upsellCount: b.upsellCount,
      },
    };
  });

  const { error } = await sb
    .from("phx_summary_snapshots")
    .upsert(snapshotRows, {
      onConflict: "tenant_id,store_id,range_from,range_to",
    });
  if (error) {
    throw new Error(`phx_summary_snapshots upsert failed: ${error.message}`);
  }

  let totalBilledCount = 0;
  let totalBilledRevenue = 0;
  for (const store of STORES) {
    const b = stores[store];
    totalBilledCount +=
      b.initialCount + b.recurringCount + b.salvageCount + b.directCount + b.upsellCount;
    totalBilledRevenue += b.initial + b.recurring + b.salvage + b.direct + b.upsell;
  }

  return {
    day,
    rowsUpserted: snapshotRows.length,
    totalBilledCount,
    totalBilledRevenue: round2(totalBilledRevenue),
  };
}

/** Sync an inclusive range of days. Returns per-day results. */
export async function syncPhoenixPortalRange(
  tenantId: string,
  from: string,
  to: string,
): Promise<PortalDayResult[]> {
  const out: PortalDayResult[] = [];
  let cur = from;
  // iterate days inclusively
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  while (new Date(`${cur}T00:00:00.000Z`).getTime() <= end) {
    out.push(await syncPhoenixPortalDay(tenantId, cur));
    const d = new Date(`${cur}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

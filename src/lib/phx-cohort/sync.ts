// Phoenix cohort-charge sync (Phase 7 — Churn engine).
//
// For cohort-based churn we need every Phoenix billing charge as its own row,
// tagged with the customer, the cycle number, and whether it settled. We reuse
// the bulk get_details feed (same as the capture-only billing sync) but instead
// of aggregating per store, we persist one phx_cohort_charges row per charge.
//
// Cycle parsing (from the Type field):
//   "Vip Initial"            → cycle 0
//   "1 Month" / "3 Month"    → cycle N
//   "Month 2 Salvage" / etc. → the salvage of cycle N (still that cycle's rebill)
//   "Direct" / "Upsell"      → skipped (not part of the subscription ladder)
//
// Status:
//   approved = settled Capture/Direct Sale, not FailedTransaction
//   declined = a failed rebill attempt (FailedTransaction true) on a cycle row
//
// Idempotent: upsert on (tenant_id, order_id).

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  fetchDayTransactions,
  portalStoreFromDomain,
  type PortalTxn,
} from "@/lib/phoenix-portal/client";

/** Parse the subscription cycle from a Phoenix Type string. Returns null for
 *  types that aren't part of the recurring ladder (Direct, Upsell, unknown). */
export function cycleOfType(type: string | null | undefined): number | null {
  const t = (type || "").toLowerCase();
  if (t.includes("initial")) return 0;
  // "N Month" (incl. "Month N Salvage") → cycle N. The salvage of cycle N is
  // still an attempt to bill that same cycle, so it shares the cycle number.
  const m = t.match(/\b(\d+)\s*month\b/);
  if (m) return Number(m[1]);
  return null; // Direct / Upsell / refund / void — not a ladder cycle
}

/** Parse the numeric customer id from the "Customer" display field
 *  ("4712333 - Michael - Fitzhugh") or the CustomerId field. */
function customerIdOf(tx: PortalTxn): number | null {
  if (tx.CustomerId != null) {
    const n = Number(tx.CustomerId);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const head = (tx.Customer || "").split("-")[0]?.trim();
  const n = Number(head);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type CohortChargeRow = {
  tenant_id: string;
  customer_id: number;
  order_id: number | null;
  store_id: string | null;
  cycle: number;
  charge_type: string | null;
  is_upsell: boolean;
  status: "approved" | "declined";
  amount: number;
  txn_date: string;
  raw_type: string | null;
  synced_at: string;
};

export type CohortDayResult = {
  day: string;
  rowsUpserted: number;
  approved: number;
  declined: number;
  skipped: number;
};

/**
 * Sync one day of Phoenix charges into phx_cohort_charges (one row per ladder
 * charge). Idempotent on (tenant_id, order_id).
 */
export async function syncPhxCohortDay(
  tenantId: string,
  day: string,
): Promise<CohortDayResult> {
  const txns = await fetchDayTransactions(tenantId, day);
  const rows: CohortChargeRow[] = [];
  const now = new Date().toISOString();
  let skipped = 0;

  for (const tx of txns) {
    const cycle = cycleOfType(tx.Type);
    if (cycle == null) {
      skipped++;
      continue; // not a subscription-ladder charge
    }
    const customerId = customerIdOf(tx);
    const orderId = tx.OrderId ?? null;
    if (customerId == null || orderId == null) {
      skipped++;
      continue; // can't anchor the charge without a customer + unique order
    }
    // approved = a settled capture; declined = a failed rebill attempt.
    const settled =
      !tx.FailedTransaction &&
      (tx.TransactionType === "Capture" || tx.TransactionType === "Direct Sale");
    // Only count failed *rebill* attempts as declines (a failed Pre-Auth/Capture
    // on a ladder cycle). Skip anything that's neither settled nor a clear decline.
    const declined = tx.FailedTransaction === true;
    if (!settled && !declined) {
      skipped++;
      continue;
    }
    rows.push({
      tenant_id: tenantId,
      customer_id: customerId,
      order_id: orderId,
      store_id: portalStoreFromDomain(tx.Domain),
      cycle,
      charge_type: tx.Type ?? null,
      is_upsell: tx.IsUpsell === true,
      status: settled ? "approved" : "declined",
      amount: Number(tx.Amount) || 0,
      txn_date: day,
      raw_type: tx.TransactionType ?? null,
      synced_at: now,
    });
  }

  const sb = supabaseAdmin();
  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("phx_cohort_charges")
      .upsert(slice, { onConflict: "tenant_id,order_id" });
    if (error) throw new Error(`phx_cohort_charges upsert failed: ${error.message}`);
    upserted += slice.length;
  }

  return {
    day,
    rowsUpserted: upserted,
    approved: rows.filter((r) => r.status === "approved").length,
    declined: rows.filter((r) => r.status === "declined").length,
    skipped,
  };
}

/** Sync a date range [from..to] inclusive, day by day. */
export async function syncPhxCohortRange(
  tenantId: string,
  from: string,
  to: string,
): Promise<{ days: number; approved: number; declined: number; failed: number }> {
  const days: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cur <= end) {
    days.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  let approved = 0;
  let declined = 0;
  let failed = 0;
  for (const day of days) {
    try {
      const r = await syncPhxCohortDay(tenantId, day);
      approved += r.approved;
      declined += r.declined;
    } catch {
      failed++;
    }
  }
  return { days: days.length, approved, declined, failed };
}

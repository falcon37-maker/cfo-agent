// Paysight → DB sync.
//
// Pulls per-subscription and per-transaction rows from Paysight for a date
// window and upserts them into paysight_subscriptions / paysight_transactions.
// Both feed the combined Phoenix+Paysight subscription view on the dashboard.
//
// Store mapping: Paysight returns a `descriptor` (e.g. "NURACARE.SHOP") and a
// `mid`. We map descriptor → our store id. Unknown descriptors are stored
// with store_id = null so nothing is silently dropped.

import {
  iterateSubscriptions,
  iterateTransactions,
  type PaysightSubscription,
  type PaysightTransaction,
} from "./client";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Map a Paysight descriptor (case-insensitive, trimmed) to our store id.
// Descriptors observed: "NURACARE.SHOP", "KOVACARE.SHOP", "NOVASENSE..." etc.
// Extend this as new stores appear.
const STORE_BY_DESCRIPTOR: Array<{ match: RegExp; store: string }> = [
  { match: /nuracare/i, store: "NURA" },
  { match: /kovacare/i, store: "KOVA" },
  { match: /novasense|nova[\s.]?usa|ross-usa/i, store: "NOVA" },
];

export function storeFromDescriptor(descriptor: string | null | undefined): string | null {
  if (!descriptor) return null;
  const d = descriptor.trim();
  for (const { match, store } of STORE_BY_DESCRIPTOR) {
    if (match.test(d)) return store;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Derive the store-local date (YYYY-MM-DD) for a transaction. Paysight
// timestamps are UTC; we currently bucket by UTC date (store-tz refinement
// can come later once we confirm Paysight's timezone semantics with the
// client). Falls back to `sent` if `completed` is missing.
function txnDate(t: PaysightTransaction): string | null {
  const iso = t.completed || t.sent;
  if (!iso) return null;
  return iso.slice(0, 10);
}

export type PaysightSyncResult = {
  subscriptionsUpserted: number;
  transactionsUpserted: number;
  dateFrom: string;
  dateTo: string;
};

/**
 * Sync subscriptions for a single day (the broad-search API caps the
 * date-only window at 1 day, so dateFrom === dateTo).
 */
export async function syncSubscriptionsForDay(
  tenantId: string,
  date: string,
): Promise<number> {
  const sb = supabaseAdmin();
  const rows: Array<Record<string, unknown>> = [];

  for await (const s of iterateSubscriptions(tenantId, date)) {
    rows.push(subscriptionRow(tenantId, s));
  }

  if (rows.length === 0) return 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb
      .from("paysight_subscriptions")
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: "tenant_id,paysight_subscription_id",
      });
    if (error) {
      throw new Error(`paysight_subscriptions upsert failed: ${error.message}`);
    }
  }
  return rows.length;
}

/**
 * Sync transactions for a date window (≤ 7 days per the API). The caller
 * can pass a single day (from === to) for daily cron, or a wider window
 * for backfills.
 */
export async function syncTransactionsForRange(
  tenantId: string,
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const sb = supabaseAdmin();
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for await (const t of iterateTransactions(tenantId, dateFrom, dateTo)) {
    if (seen.has(t.transactionId)) continue;
    seen.add(t.transactionId);
    rows.push(transactionRow(tenantId, t));
  }

  if (rows.length === 0) return 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb
      .from("paysight_transactions")
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: "tenant_id,paysight_transaction_id",
      });
    if (error) {
      throw new Error(`paysight_transactions upsert failed: ${error.message}`);
    }
  }
  return rows.length;
}

/** Sync both subscriptions + transactions for a single day. */
export async function syncPaysightDay(
  tenantId: string,
  date: string,
): Promise<PaysightSyncResult> {
  const subscriptionsUpserted = await syncSubscriptionsForDay(tenantId, date);
  const transactionsUpserted = await syncTransactionsForRange(
    tenantId,
    date,
    date,
  );
  return {
    subscriptionsUpserted,
    transactionsUpserted,
    dateFrom: date,
    dateTo: date,
  };
}

// ─── Row mappers ──────────────────────────────────────────────────────

function subscriptionRow(
  tenantId: string,
  s: PaysightSubscription,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    paysight_subscription_id: s.id,
    parent_company_id: s.parentCompanyId ?? null,
    company_id: s.companyId ?? null,
    customer_id: s.customerId ?? null,
    order_id: s.orderId ?? null,
    sub_plan_id: s.subId ?? null,
    store_id: storeFromDescriptor(s.descriptor),
    mid: s.mid ?? null,
    descriptor: s.descriptor ?? null,
    active: s.active ?? null,
    frozen: s.frozen ?? null,
    unsubscribe_order_id: s.unsubscribeOrderId ?? null,
    email: s.email ?? null,
    sub_date: s.subDate ?? null,
    unsub_date: s.unsubDate ?? null,
    raw: s,
    synced_at: new Date().toISOString(),
  };
}

function transactionRow(
  tenantId: string,
  t: PaysightTransaction,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    paysight_transaction_id: t.transactionId,
    parent_company_id: null, // not on the transaction object; ClientId is the tenant
    company_id: null,
    order_id: t.orderId ?? null,
    customer_id: t.customerId ?? null,
    application_id: t.applicationId ?? null,
    store_id: storeFromDescriptor(t.descriptor),
    mid: t.mid ?? null,
    descriptor: t.descriptor ?? null,
    amount: round2(Number(t.amount ?? 0)),
    currency: t.currency ?? null,
    status: t.status ?? null,
    status_id: t.statusId ?? null,
    success: t.success ?? null,
    refunded: t.refunded ?? null,
    charged_back: t.chargedBack ?? null,
    has_alert: t.hasAlert ?? null,
    original_transaction_id: t.originalTransactionId ?? null,
    email: t.email ?? null,
    first_name: t.firstName ?? null,
    last_name: t.lastName ?? null,
    bin: t.bin ?? null,
    last4: t.last4 ?? null,
    sent_at: t.sent ?? null,
    completed_at: t.completed ?? null,
    txn_date: txnDate(t),
    gateway: t.gateway ?? null,
    gateway_transaction_id: t.gatewayTransactionId ?? null,
    sandbox: Boolean(t.sandbox),
    raw: t,
    synced_at: new Date().toISOString(),
  };
}

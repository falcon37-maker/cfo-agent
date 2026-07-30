// ─────────────────────────────────────────────────────────────────────────────
// Store classification + processing-fee rates — the single source of truth.
//
// Client spec (Jun 2026):
//   subscription stores (NOVA / NURA / KOVA, billed via Phoenix/Paysight)
//       → 16.3% on EVERYTHING they take: Shopify checkout + billed subscriptions
//   drop-ship stores (everyone else)
//       → 3.9% on their Shopify revenue
//
// These rates are applied at read time, NOT read from `stores.processing_fee_pct`
// or from the stored `daily_pnl.fees` / `daily_pnl.net_profit`. Those columns are
// per-store and had drifted (subscription stores sat at 10%, drop-ship at
// 2.7–3.0%), which is what made the Dashboard and the Subscriptions page report
// different Net Profit for the same day. Recomputing here keeps every page,
// export and total on one rule.
// ─────────────────────────────────────────────────────────────────────────────

/** Stores billed through the subscription platform (Phoenix / Paysight). */
export const SUBSCRIPTION_STORE_IDS = new Set(["NOVA", "NURA", "KOVA"]);

/** Processing fee for subscription stores — checkout AND billed subscriptions. */
export const SUBS_FEE_RATE = 0.163;

/** Processing fee for drop-ship Shopify stores. */
export const DROPSHIP_FEE_RATE = 0.039;

export function isSubscriptionStore(storeId: string): boolean {
  return SUBSCRIPTION_STORE_IDS.has(storeId.toUpperCase());
}

/** The fee rate that applies to a given store's revenue. */
export function feeRateFor(storeId: string): number {
  return isSubscriptionStore(storeId) ? SUBS_FEE_RATE : DROPSHIP_FEE_RATE;
}

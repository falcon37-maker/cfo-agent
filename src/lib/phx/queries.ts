// Read-side queries for the /subscriptions tab. Data is produced by the
// cfo-agent-phx-extension Chrome extension, which scrapes PHX dashboards and
// upserts one row per (store, scrape_date) into phx_summary_snapshots.

import { supabaseAdmin } from "@/lib/supabase/admin";

export type PhxSnapshot = {
  store_id: string;
  scrape_date: string;
  scraped_at: string;
  range_from: string | null;
  range_to: string | null;

  // Order Summary
  direct_sale_count: number | null;
  direct_sale_success_pct: number | null;
  initial_subscription_count: number | null;
  initial_subscription_success_pct: number | null;
  recurring_subscription_count: number | null;
  recurring_subscription_success_pct: number | null;
  subscription_salvage_count: number | null;
  subscription_salvage_success_pct: number | null;
  upsell_count: number | null;
  upsell_success_pct: number | null;
  target_cac: number | null;
  subscriptions_to_bill: number | null;

  // MTD
  total_transactions_mtd: number | null;
  refunds_mtd_count: number | null;
  refunds_mtd_pct: number | null;
  chargebacks_mtd_count: number | null;
  chargebacks_mtd_pct: number | null;

  // Lifetime
  active_subscribers: number | null;
  subscribers_in_salvage: number | null;
  cancelled_subscribers: number | null;

  // Refund summary
  refund_total: number | null;
  refund_agent: number | null;
  refund_ethoca: number | null;
  refund_cdrn: number | null;
  refund_rdr_withdrawals: number | null;
  refund_chargeback_withdrawals: number | null;
};

export type PhxStoreSnapshot = {
  store_id: string;
  store_name: string;
  snapshot: PhxSnapshot | null;
};

/**
 * Returns the latest snapshot for every active store. When `range` is passed,
 * only considers snapshots whose `scrape_date` is in [range.from, range.to].
 * Stores with no snapshot in that window get `snapshot: null`.
 */
export async function loadLatestSnapshots(range?: {
  from: string;
  to: string;
}): Promise<PhxStoreSnapshot[]> {
  const sb = supabaseAdmin();
  const { data: stores, error: sErr } = await sb
    .from("stores")
    .select("id, name")
    .eq("is_active", true)
    .order("id");
  if (sErr) throw new Error(`stores: ${sErr.message}`);

  const results: PhxStoreSnapshot[] = [];
  for (const s of stores ?? []) {
    let q = sb
      .from("phx_summary_snapshots")
      .select("*")
      .eq("store_id", s.id);
    if (range) {
      q = q.gte("scrape_date", range.from).lte("scrape_date", range.to);
    }
    const { data } = await q.order("scraped_at", { ascending: false }).limit(1);
    results.push({
      store_id: s.id,
      store_name: s.name,
      snapshot: (data?.[0] as PhxSnapshot) ?? null,
    });
  }
  return results;
}

/** Aggregate summed numeric fields across multiple snapshots. */
export function aggregateSnapshots(snaps: PhxSnapshot[]): PhxSnapshot | null {
  if (snaps.length === 0) return null;
  const first = snaps[0];
  const out: PhxSnapshot = {
    store_id: "ALL",
    scrape_date: first.scrape_date,
    scraped_at: first.scraped_at,
    range_from: first.range_from,
    range_to: first.range_to,
    direct_sale_count: 0,
    direct_sale_success_pct: null,
    initial_subscription_count: 0,
    initial_subscription_success_pct: null,
    recurring_subscription_count: 0,
    recurring_subscription_success_pct: null,
    subscription_salvage_count: 0,
    subscription_salvage_success_pct: null,
    upsell_count: 0,
    upsell_success_pct: null,
    target_cac: null,
    subscriptions_to_bill: 0,
    total_transactions_mtd: 0,
    refunds_mtd_count: 0,
    refunds_mtd_pct: null,
    chargebacks_mtd_count: 0,
    chargebacks_mtd_pct: null,
    active_subscribers: 0,
    subscribers_in_salvage: 0,
    cancelled_subscribers: 0,
    refund_total: 0,
    refund_agent: 0,
    refund_ethoca: 0,
    refund_cdrn: 0,
    refund_rdr_withdrawals: 0,
    refund_chargeback_withdrawals: 0,
  };

  // Sum additive fields across snapshots.
  const sumKeys: (keyof PhxSnapshot)[] = [
    "direct_sale_count",
    "initial_subscription_count",
    "recurring_subscription_count",
    "subscription_salvage_count",
    "upsell_count",
    "subscriptions_to_bill",
    "total_transactions_mtd",
    "refunds_mtd_count",
    "chargebacks_mtd_count",
    "active_subscribers",
    "subscribers_in_salvage",
    "cancelled_subscribers",
    "refund_total",
    "refund_agent",
    "refund_ethoca",
    "refund_cdrn",
    "refund_rdr_withdrawals",
    "refund_chargeback_withdrawals",
  ];
  for (const s of snaps) {
    for (const k of sumKeys) {
      const v = s[k];
      if (typeof v === "number") (out[k] as number) += v;
    }
    // Take the latest scrape_at as the aggregate's "as of"
    if (s.scraped_at > out.scraped_at) out.scraped_at = s.scraped_at;
  }

  // Derived weighted averages for the ratio fields.
  out.refunds_mtd_pct = safeDiv(out.refunds_mtd_count, out.total_transactions_mtd) * 100;
  out.chargebacks_mtd_pct = safeDiv(out.chargebacks_mtd_count, out.total_transactions_mtd) * 100;
  // Success percentages across stores aren't meaningfully summable without the
  // per-store denominators, so leave them null for the ALL view.

  // Blended CAC is meaningful if every store has one.
  const cacs = snaps.map((s) => s.target_cac).filter((v): v is number => typeof v === "number");
  if (cacs.length === snaps.length && cacs.length > 0) {
    out.target_cac = cacs.reduce((a, b) => a + b, 0) / cacs.length;
  }

  return out;
}

function safeDiv(a: number | null, b: number | null): number {
  if (!a || !b) return 0;
  return a / b;
}

// Daily P&L computation.
// Formula (Phase 1, per user spec):
//   revenue     = daily_orders.gross_sales
//   cogs        = order_count * stores.default_cogs_per_order     (blended)
//   fees        = gross_sales  * stores.processing_fee_pct        (processor + Shopify)
//   refunds     = daily_orders.refunds
//   ad_spend    = sum(daily_ad_spend.spend)                       (0 until Phase 2)
//   gross_profit = revenue - cogs
//   net_profit   = revenue - cogs - fees - refunds - ad_spend
//   margin_pct   = net_profit / revenue * 100

import { supabaseAdmin } from "@/lib/supabase/admin";

export type DailyPnl = {
  store_id: string;
  date: string;
  revenue: number;
  cogs: number;
  refunds: number;
  fees: number;
  ad_spend: number;
  shipping_cost: number;
  gross_profit: number;
  net_profit: number;
  margin_pct: number;
};

export async function computeDailyPnl(
  storeCode: string,
  date: string,
  tenantId: string,
): Promise<DailyPnl | null> {
  const sb = supabaseAdmin();
  const code = storeCode.toUpperCase();

  const { data: store, error: storeErr } = await sb
    .from("stores")
    .select("default_cogs_per_order, processing_fee_pct")
    .eq("tenant_id", tenantId)
    .eq("id", code)
    .maybeSingle();
  if (storeErr) throw new Error(`stores lookup failed: ${storeErr.message}`);
  if (!store) throw new Error(`store ${code} not found`);

  const { data: orders, error: ordErr } = await sb
    .from("daily_orders")
    .select("order_count, gross_sales, refunds")
    .eq("tenant_id", tenantId)
    .eq("store_id", code)
    .eq("date", date)
    .maybeSingle();
  if (ordErr) throw new Error(`daily_orders lookup failed: ${ordErr.message}`);
  if (!orders) return null; // no orders synced for that day — skip

  const { data: adRows, error: adErr } = await sb
    .from("daily_ad_spend")
    .select("spend")
    .eq("tenant_id", tenantId)
    .eq("store_id", code)
    .eq("date", date);
  if (adErr) throw new Error(`daily_ad_spend lookup failed: ${adErr.message}`);

  const cogsPerOrder = Number(store.default_cogs_per_order ?? 0);
  const feePct = Number(store.processing_fee_pct ?? 0);

  const revenue = Number(orders.gross_sales);
  const cogs = Number(orders.order_count) * cogsPerOrder;
  const fees = revenue * feePct;
  const refunds = Number(orders.refunds);
  const adSpend = (adRows ?? []).reduce((sum, r) => sum + Number(r.spend ?? 0), 0);

  const grossProfit = revenue - cogs;
  const netProfit = revenue - cogs - fees - refunds - adSpend;
  const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const row: DailyPnl = {
    store_id: code,
    date,
    revenue: r2(revenue),
    cogs: r2(cogs),
    refunds: r2(refunds),
    fees: r2(fees),
    ad_spend: r2(adSpend),
    shipping_cost: 0,
    gross_profit: r2(grossProfit),
    net_profit: r2(netProfit),
    margin_pct: r2(marginPct),
  };

  const { error: upErr } = await sb
    .from("daily_pnl")
    .upsert(
      {
        ...row,
        tenant_id: tenantId,
        order_count: Number(orders.order_count) ?? 0,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "store_id,date" },
    );
  if (upErr) throw new Error(`daily_pnl upsert failed: ${upErr.message}`);

  return row;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

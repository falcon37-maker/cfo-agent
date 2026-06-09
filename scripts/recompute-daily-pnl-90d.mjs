// After daily_orders has been resynced, recompute daily_pnl for the
// same 90-day window. Mirrors src/lib/pnl/compute.ts.
//
// Usage: node --env-file=.env scripts/recompute-daily-pnl-90d.mjs

import { createClient } from "@supabase/supabase-js";

const DAYS = 90;
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const r2 = (n) => Math.round(n * 100) / 100;

const { data: stores } = await sb
  .from("stores")
  .select("id, tenant_id, timezone, default_cogs_per_order, processing_fee_pct, is_active")
  .eq("is_active", true);

const targets = (stores ?? []).filter(
  (s) => s.id !== "PORTFOLIO" && s.id !== "__BACKFILL_DEDUPE__",
);

console.log(`\n═══ daily_pnl recompute for ${targets.length} stores × ${DAYS} days ═══\n`);

const summary = [];
for (const store of targets) {
  const tz = store.timezone || "UTC";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const [ty, tm, td] = today.split("-").map(Number);
  const dates = [];
  for (let i = 0; i < DAYS; i++) {
    const dt = new Date(Date.UTC(ty, tm - 1, td - i));
    dates.push(dt.toISOString().slice(0, 10));
  }

  let computed = 0, skipped = 0, errs = 0;
  for (const date of dates) {
    try {
      const { data: orders } = await sb
        .from("daily_orders")
        .select("order_count, gross_sales, refunds")
        .eq("tenant_id", store.tenant_id)
        .eq("store_id", store.id)
        .eq("date", date)
        .maybeSingle();
      if (!orders) { skipped++; continue; }

      const { data: adRows } = await sb
        .from("daily_ad_spend")
        .select("spend")
        .eq("tenant_id", store.tenant_id)
        .eq("store_id", store.id)
        .eq("date", date);

      const cogsPerOrder = Number(store.default_cogs_per_order ?? 0);
      const feePct = Number(store.processing_fee_pct ?? 0);
      const grossSales = Number(orders.gross_sales);
      const refunds = Number(orders.refunds);
      const revenue = r2(grossSales - refunds);
      const cogs = Number(orders.order_count) * cogsPerOrder;
      const fees = revenue * feePct;
      const adSpend = (adRows ?? []).reduce((s, r) => s + Number(r.spend ?? 0), 0);
      const grossProfit = revenue - cogs;
      const netProfit = revenue - cogs - fees - adSpend;
      const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

      const { error } = await sb.from("daily_pnl").upsert({
        tenant_id: store.tenant_id,
        store_id: store.id,
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
        order_count: Number(orders.order_count) ?? 0,
        computed_at: new Date().toISOString(),
      }, { onConflict: "store_id,date" });
      if (error) { errs++; console.log(`  ${store.id} ${date}: ${error.message}`); }
      else computed++;
    } catch (e) {
      errs++;
      console.log(`  ${store.id} ${date}: ${e.message}`);
    }
  }
  console.log(`  ${store.id.padEnd(8)} — ${computed} computed, ${skipped} no-data, ${errs} errors`);
  summary.push({ store: store.id, computed, skipped, errs });
}

console.log("");
console.table(summary);

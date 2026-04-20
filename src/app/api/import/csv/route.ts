import { NextRequest } from "next/server";
import { loadShopCsv } from "@/lib/import/shop-csv";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/import/csv?store=NOVA
// Body: { path: "/absolute/path/to/Ecom Shops - XXX.csv" }
//
// Imports the manually-tracked spreadsheet for a store. Upserts:
//   - daily_pnl       (authoritative P&L for the date)
//   - daily_orders    (order_count + revenue as gross_sales; refunds/tax/shipping left 0)
//   - daily_ad_spend  (platform = 'facebook')
// Skips all-zero rows.
export async function POST(request: NextRequest) {
  const storeCode = (request.nextUrl.searchParams.get("store") ?? "").toUpperCase();
  if (!storeCode) {
    return Response.json({ error: "missing `store`" }, { status: 400 });
  }

  let body: { path?: string } = {};
  try {
    body = await request.json();
  } catch {
    // allow ?path= fallback
  }
  const path = body.path ?? request.nextUrl.searchParams.get("path");
  if (!path) {
    return Response.json({ error: "missing `path`" }, { status: 400 });
  }

  try {
    const sb = supabaseAdmin();

    const { data: store, error: storeErr } = await sb
      .from("stores")
      .select("id, currency")
      .eq("id", storeCode)
      .maybeSingle();
    if (storeErr) throw new Error(`stores lookup failed: ${storeErr.message}`);
    if (!store) {
      return Response.json(
        { error: `store ${storeCode} not found — insert a row in \`stores\` first` },
        { status: 400 },
      );
    }
    const currency = store.currency ?? "USD";

    const rows = await loadShopCsv(path);
    if (rows.length === 0) {
      return Response.json({ ok: true, imported: 0, note: "no non-empty rows" });
    }

    const pnlRows = rows.map((r) => {
      const grossProfit = r.revenue - r.cogs;
      const marginPct = r.revenue > 0 ? (r.netProfit / r.revenue) * 100 : 0;
      return {
        store_id: storeCode,
        date: r.date,
        revenue: round2(r.revenue),
        cogs: round2(r.cogs),
        fees: round2(r.fees),
        refunds: 0,
        ad_spend: round2(r.adSpend),
        shipping_cost: 0,
        gross_profit: round2(grossProfit),
        net_profit: round2(r.netProfit),
        margin_pct: round2(marginPct),
        order_count: r.orders,
        computed_at: new Date().toISOString(),
      };
    });

    const ordersRows = rows.map((r) => ({
      store_id: storeCode,
      date: r.date,
      order_count: r.orders,
      unit_count: 0,
      gross_sales: round2(r.revenue),
      discounts: 0,
      refunds: 0,
      shipping: 0,
      tax: 0,
      net_revenue: round2(r.revenue),
      currency,
      synced_at: new Date().toISOString(),
    }));

    const adRows = rows
      .filter((r) => r.facebookSpend > 0)
      .map((r) => ({
        store_id: storeCode,
        date: r.date,
        platform: "facebook",
        spend: round2(r.facebookSpend),
        currency,
        synced_at: new Date().toISOString(),
      }));

    const { error: pnlErr } = await sb
      .from("daily_pnl")
      .upsert(pnlRows, { onConflict: "store_id,date" });
    if (pnlErr) throw new Error(`daily_pnl upsert failed: ${pnlErr.message}`);

    const { error: ordErr } = await sb
      .from("daily_orders")
      .upsert(ordersRows, { onConflict: "store_id,date" });
    if (ordErr) throw new Error(`daily_orders upsert failed: ${ordErr.message}`);

    if (adRows.length > 0) {
      const { error: adErr } = await sb
        .from("daily_ad_spend")
        .upsert(adRows, { onConflict: "store_id,date,platform" });
      if (adErr) throw new Error(`daily_ad_spend upsert failed: ${adErr.message}`);
    }

    const totals = rows.reduce(
      (acc, r) => {
        acc.revenue += r.revenue;
        acc.adSpend += r.adSpend;
        acc.netProfit += r.netProfit;
        acc.orders += r.orders;
        return acc;
      },
      { revenue: 0, adSpend: 0, netProfit: 0, orders: 0 },
    );

    return Response.json({
      ok: true,
      storeCode,
      imported: rows.length,
      adRowsUpserted: adRows.length,
      dateRange: { from: rows[0].date, to: rows[rows.length - 1].date },
      totals: {
        revenue: round2(totals.revenue),
        adSpend: round2(totals.adSpend),
        netProfit: round2(totals.netProfit),
        orders: totals.orders,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

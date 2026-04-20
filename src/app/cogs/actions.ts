"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Manual daily-COGS submission. Middleware guarantees the user is logged in
 * before this action can fire, but we re-fetch the session defensively in
 * case the cookie expired between navigation and the form post.
 */
export async function submitCogsAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/cogs");

  const storeId = String(formData.get("store") ?? "").toUpperCase();
  const date = String(formData.get("date") ?? "");
  const cogs = Number(String(formData.get("cogs") ?? ""));

  if (
    !storeId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(cogs) ||
    cogs < 0
  ) {
    redirect("/cogs?err=input");
  }

  const sb = supabaseAdmin();
  const now = new Date().toISOString();

  // Pull existing daily_pnl row (if any) so we preserve revenue/fees/ad_spend
  // and recompute derived profit fields from the new COGS.
  const { data: existing, error: selErr } = await sb
    .from("daily_pnl")
    .select(
      "revenue, fees, ad_spend, refunds, shipping_cost, order_count",
    )
    .eq("store_id", storeId)
    .eq("date", date)
    .maybeSingle();
  if (selErr) redirect("/cogs?err=db");

  const revenue = Number(existing?.revenue ?? 0);
  const fees = Number(existing?.fees ?? 0);
  const adSpend = Number(existing?.ad_spend ?? 0);
  const refunds = Number(existing?.refunds ?? 0);
  const shippingCost = Number(existing?.shipping_cost ?? 0);
  const orderCount = Number(existing?.order_count ?? 0);

  const grossProfit = revenue - cogs;
  const netProfit = revenue - cogs - fees - refunds - adSpend;
  const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const { error: upErr } = await sb.from("daily_pnl").upsert(
    {
      store_id: storeId,
      date,
      revenue: round2(revenue),
      cogs: round2(cogs),
      fees: round2(fees),
      refunds: round2(refunds),
      ad_spend: round2(adSpend),
      shipping_cost: round2(shippingCost),
      gross_profit: round2(grossProfit),
      net_profit: round2(netProfit),
      margin_pct: round2(marginPct),
      order_count: orderCount,
      computed_at: now,
    },
    { onConflict: "store_id,date" },
  );
  if (upErr) redirect("/cogs?err=db");

  const { error: logErr } = await sb.from("cogs_entries").insert({
    store_id: storeId,
    date,
    cogs: round2(cogs),
    submitted_by: user.email ?? user.id,
  });
  if (logErr) redirect("/cogs?err=db");

  revalidatePath("/cogs");
  redirect(
    `/cogs?ok=${encodeURIComponent(`${storeId} · ${date} · $${cogs.toFixed(2)}`)}`,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

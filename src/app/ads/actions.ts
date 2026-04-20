"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function submitAdSpendAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/ads");

  const storeId = String(formData.get("store") ?? "").toUpperCase();
  const date = String(formData.get("date") ?? "");
  const amount = Number(String(formData.get("amount") ?? ""));

  if (
    !storeId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    redirect("/ads?err=input");
  }

  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  const roundedAmount = Math.round(amount * 100) / 100;

  // 1. Upsert the ad-spend row. Keyed on platform='facebook' to stay
  // consistent with the CSV-imported historical data.
  const { error: adErr } = await sb.from("daily_ad_spend").upsert(
    {
      store_id: storeId,
      date,
      platform: "facebook",
      spend: roundedAmount,
      currency: "USD",
      synced_at: now,
    },
    { onConflict: "store_id,date,platform" },
  );
  if (adErr) redirect("/ads?err=db");

  // 2. Sum every platform for (store, date) and mirror into daily_pnl.ad_spend.
  const { data: allSpendRows, error: sumErr } = await sb
    .from("daily_ad_spend")
    .select("spend")
    .eq("store_id", storeId)
    .eq("date", date);
  if (sumErr) redirect("/ads?err=db");
  const totalSpend = (allSpendRows ?? []).reduce(
    (s, r) => s + Number(r.spend ?? 0),
    0,
  );

  const { data: existingPnl, error: pnlSelErr } = await sb
    .from("daily_pnl")
    .select(
      "revenue, cogs, fees, refunds, shipping_cost, gross_profit, net_profit, margin_pct, order_count",
    )
    .eq("store_id", storeId)
    .eq("date", date)
    .maybeSingle();
  if (pnlSelErr) redirect("/ads?err=db");

  const revenue = Number(existingPnl?.revenue ?? 0);
  const cogs = Number(existingPnl?.cogs ?? 0);
  const fees = Number(existingPnl?.fees ?? 0);
  const refunds = Number(existingPnl?.refunds ?? 0);
  const adSpend = Math.round(totalSpend * 100) / 100;
  const grossProfit = revenue - cogs;
  const netProfit = revenue - cogs - fees - refunds - adSpend;
  const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const pnlRow = {
    store_id: storeId,
    date,
    revenue,
    cogs,
    fees,
    refunds,
    ad_spend: adSpend,
    shipping_cost: Number(existingPnl?.shipping_cost ?? 0),
    gross_profit: Math.round(grossProfit * 100) / 100,
    net_profit: Math.round(netProfit * 100) / 100,
    margin_pct: Math.round(marginPct * 100) / 100,
    order_count: Number(existingPnl?.order_count ?? 0),
    computed_at: now,
  };

  const { error: pnlUpErr } = await sb
    .from("daily_pnl")
    .upsert(pnlRow, { onConflict: "store_id,date" });
  if (pnlUpErr) redirect("/ads?err=db");

  // 3. Append to audit log with the Supabase user's email.
  const { error: logErr } = await sb.from("ad_spend_entries").insert({
    store_id: storeId,
    date,
    amount: roundedAmount,
    submitted_by: user.email ?? user.id,
  });
  if (logErr) redirect("/ads?err=db");

  revalidatePath("/ads");
  redirect(
    `/ads?ok=${encodeURIComponent(`${storeId} · ${date} · $${roundedAmount.toFixed(2)}`)}`,
  );
}

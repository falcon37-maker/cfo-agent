"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCurrentTenant, WRITE_DATA_ROLES } from "@/lib/tenant";

export async function submitAdSpendAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/ads");
  const tenant = await getCurrentTenant(auth);
  if (!WRITE_DATA_ROLES.includes(tenant.role)) {
    redirect("/ads?err=forbidden");
  }

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
      tenant_id: tenant.id,
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
    .eq("tenant_id", tenant.id)
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
    .eq("tenant_id", tenant.id)
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
    tenant_id: tenant.id,
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
    tenant_id: tenant.id,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Recompute daily_ad_spend for a (store, date, platform) from the latest
 * matching ad_spend_entries row, then roll up all platforms into
 * daily_pnl.ad_spend and recompute profit fields.
 */
async function recomputeAdSpendFor(
  sb: ReturnType<typeof supabaseAdmin>,
  storeId: string,
  date: string,
  platform: string,
  now: string,
  tenantId: string,
): Promise<"ok" | "db"> {
  // Use the latest remaining entry for this (store, date, platform) as the
  // canonical spend. If none remain, set daily_ad_spend to 0.
  const { data: latest } = await sb
    .from("ad_spend_entries")
    .select("amount")
    .eq("tenant_id", tenantId)
    .eq("store_id", storeId)
    .eq("date", date)
    .order("submitted_at", { ascending: false })
    .limit(1);
  const spend = round2(Number(latest?.[0]?.amount ?? 0));

  const { error: upErr } = await sb.from("daily_ad_spend").upsert(
    {
      tenant_id: tenantId,
      store_id: storeId,
      date,
      platform,
      spend,
      currency: "USD",
      synced_at: now,
    },
    { onConflict: "store_id,date,platform" },
  );
  if (upErr) return "db";

  // Sum across all platforms for this (store, date) and mirror into daily_pnl.
  const { data: all } = await sb
    .from("daily_ad_spend")
    .select("spend")
    .eq("tenant_id", tenantId)
    .eq("store_id", storeId)
    .eq("date", date);
  const totalSpend = round2(
    (all ?? []).reduce((s, r) => s + Number(r.spend ?? 0), 0),
  );

  const { data: pnl } = await sb
    .from("daily_pnl")
    .select(
      "revenue, cogs, fees, refunds, shipping_cost, order_count",
    )
    .eq("tenant_id", tenantId)
    .eq("store_id", storeId)
    .eq("date", date)
    .maybeSingle();

  const revenue = Number(pnl?.revenue ?? 0);
  const cogs = Number(pnl?.cogs ?? 0);
  const fees = Number(pnl?.fees ?? 0);
  const refunds = Number(pnl?.refunds ?? 0);
  const grossProfit = revenue - cogs;
  const netProfit = revenue - cogs - fees - refunds - totalSpend;
  const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const { error: pnlErr } = await sb.from("daily_pnl").upsert(
    {
      tenant_id: tenantId,
      store_id: storeId,
      date,
      revenue: round2(revenue),
      cogs: round2(cogs),
      fees: round2(fees),
      refunds: round2(refunds),
      ad_spend: totalSpend,
      shipping_cost: Number(pnl?.shipping_cost ?? 0),
      gross_profit: round2(grossProfit),
      net_profit: round2(netProfit),
      margin_pct: round2(marginPct),
      order_count: Number(pnl?.order_count ?? 0),
      computed_at: now,
    },
    { onConflict: "store_id,date" },
  );
  return pnlErr ? "db" : "ok";
}

export async function updateAdSpendEntryAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/ads");
  const tenant = await getCurrentTenant(auth);
  if (!WRITE_DATA_ROLES.includes(tenant.role)) {
    redirect("/ads?err=forbidden");
  }

  const id = String(formData.get("id") ?? "");
  const storeId = String(formData.get("store") ?? "").toUpperCase();
  const date = String(formData.get("date") ?? "");
  const amount = Number(String(formData.get("amount") ?? ""));

  if (
    !id ||
    !storeId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    redirect("/ads?err=input");
  }

  const sb = supabaseAdmin();
  const now = new Date().toISOString();

  const { data: before, error: readErr } = await sb
    .from("ad_spend_entries")
    .select("store_id, date")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (readErr || !before) redirect("/ads?err=notfound");

  const { error: updErr } = await sb
    .from("ad_spend_entries")
    .update({ store_id: storeId, date, amount: round2(amount) })
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (updErr) redirect("/ads?err=db");

  // Recompute NEW (store, date) cell.
  if ((await recomputeAdSpendFor(sb, storeId, date, "facebook", now, tenant.id)) !== "ok") {
    redirect("/ads?err=db");
  }

  // If moved, recompute OLD cell too.
  if (before.store_id !== storeId || before.date !== date) {
    if (
      (await recomputeAdSpendFor(sb, before.store_id, before.date, "facebook", now, tenant.id)) !==
      "ok"
    ) {
      redirect("/ads?err=db");
    }
  }

  revalidatePath("/ads");
  redirect(
    `/ads?ok=${encodeURIComponent(`updated ${storeId} · ${date} · $${amount.toFixed(2)}`)}`,
  );
}

export async function deleteAdSpendEntryAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/ads");
  const tenant = await getCurrentTenant(auth);
  if (!WRITE_DATA_ROLES.includes(tenant.role)) {
    redirect("/ads?err=forbidden");
  }

  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/ads?err=input");

  const sb = supabaseAdmin();
  const now = new Date().toISOString();

  const { data: entry, error: readErr } = await sb
    .from("ad_spend_entries")
    .select("store_id, date")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (readErr || !entry) redirect("/ads?err=notfound");

  const { error: delErr } = await sb
    .from("ad_spend_entries")
    .delete()
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (delErr) redirect("/ads?err=db");

  if ((await recomputeAdSpendFor(sb, entry.store_id, entry.date, "facebook", now, tenant.id)) !== "ok") {
    redirect("/ads?err=db");
  }

  revalidatePath("/ads");
  redirect(`/ads?ok=${encodeURIComponent(`deleted ${entry.store_id} · ${entry.date}`)}`);
}

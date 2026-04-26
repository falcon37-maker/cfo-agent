"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCurrentTenant } from "@/lib/tenant";

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
  const tenant = await getCurrentTenant(auth);

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
    .eq("tenant_id", tenant.id)
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
      tenant_id: tenant.id,
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
    tenant_id: tenant.id,
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

/**
 * Apply a fresh cogs value to daily_pnl for (storeId, date). Preserves
 * revenue/fees/refunds/ad_spend and recomputes gross/net/margin. If cogs=0
 * we zero out the field but leave the row — keeps delete-then-resubmit
 * paths idempotent.
 */
async function applyCogsToDailyPnl(
  sb: ReturnType<typeof supabaseAdmin>,
  storeId: string,
  date: string,
  cogs: number,
  now: string,
  tenantId: string,
): Promise<"ok" | "db"> {
  const { data: existing, error: selErr } = await sb
    .from("daily_pnl")
    .select(
      "revenue, fees, ad_spend, refunds, shipping_cost, order_count",
    )
    .eq("tenant_id", tenantId)
    .eq("store_id", storeId)
    .eq("date", date)
    .maybeSingle();
  if (selErr) return "db";

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
      tenant_id: tenantId,
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
  return upErr ? "db" : "ok";
}

/**
 * Edit an existing cogs_entries row. Updates the entry + the downstream
 * daily_pnl row. If the store or date changed, we ALSO reset the old
 * (store, date)'s cogs to whatever the most-recent remaining entry says
 * (or 0) so we don't leave stale values behind.
 */
export async function updateCogsEntryAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/cogs");
  const tenant = await getCurrentTenant(auth);

  const id = String(formData.get("id") ?? "");
  const storeId = String(formData.get("store") ?? "").toUpperCase();
  const date = String(formData.get("date") ?? "");
  const cogs = Number(String(formData.get("cogs") ?? ""));

  if (
    !id ||
    !storeId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(cogs) ||
    cogs < 0
  ) {
    redirect("/cogs?err=input");
  }

  const sb = supabaseAdmin();
  const now = new Date().toISOString();

  // Fetch the old row so we can know if store/date moved.
  const { data: before, error: readErr } = await sb
    .from("cogs_entries")
    .select("store_id, date")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (readErr || !before) redirect("/cogs?err=notfound");

  const { error: updErr } = await sb
    .from("cogs_entries")
    .update({ store_id: storeId, date, cogs: round2(cogs) })
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (updErr) redirect("/cogs?err=db");

  // Apply new value to the new (store, date).
  if ((await applyCogsToDailyPnl(sb, storeId, date, cogs, now, tenant.id)) !== "ok") {
    redirect("/cogs?err=db");
  }

  // If the (store, date) changed, reset the OLD cell using whatever
  // remaining entry is latest for that cell.
  const movedCell =
    before && (before.store_id !== storeId || before.date !== date);
  if (movedCell && before) {
    const { data: remaining } = await sb
      .from("cogs_entries")
      .select("cogs")
      .eq("tenant_id", tenant.id)
      .eq("store_id", before.store_id)
      .eq("date", before.date)
      .order("submitted_at", { ascending: false })
      .limit(1);
    const restoreCogs = Number(remaining?.[0]?.cogs ?? 0);
    if ((await applyCogsToDailyPnl(sb, before.store_id, before.date, restoreCogs, now, tenant.id)) !== "ok") {
      redirect("/cogs?err=db");
    }
  }

  revalidatePath("/cogs");
  redirect(
    `/cogs?ok=${encodeURIComponent(`updated ${storeId} · ${date} · $${cogs.toFixed(2)}`)}`,
  );
}

/**
 * Delete a cogs_entries row. The (store, date)'s daily_pnl.cogs is reset
 * to the next-most-recent remaining entry's value (or 0 if none remain),
 * so partial history on the same day is respected.
 */
export async function deleteCogsEntryAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/cogs");
  const tenant = await getCurrentTenant(auth);

  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/cogs?err=input");

  const sb = supabaseAdmin();
  const now = new Date().toISOString();

  const { data: entry, error: readErr } = await sb
    .from("cogs_entries")
    .select("store_id, date")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (readErr || !entry) redirect("/cogs?err=notfound");

  const { error: delErr } = await sb
    .from("cogs_entries")
    .delete()
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (delErr) redirect("/cogs?err=db");

  const { data: remaining } = await sb
    .from("cogs_entries")
    .select("cogs")
    .eq("tenant_id", tenant.id)
    .eq("store_id", entry.store_id)
    .eq("date", entry.date)
    .order("submitted_at", { ascending: false })
    .limit(1);
  const restoreCogs = Number(remaining?.[0]?.cogs ?? 0);
  if ((await applyCogsToDailyPnl(sb, entry.store_id, entry.date, restoreCogs, now, tenant.id)) !== "ok") {
    redirect("/cogs?err=db");
  }

  revalidatePath("/cogs");
  redirect(`/cogs?ok=${encodeURIComponent(`deleted ${entry.store_id} · ${entry.date}`)}`);
}

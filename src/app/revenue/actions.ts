"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCurrentTenant } from "@/lib/tenant";

const VALID_TYPES = new Set([
  "Coaching",
  "Consulting",
  "One-time Sale",
  "Subscription",
  "Other",
]);

function bad(reason: string): never {
  redirect(`/revenue?err=${encodeURIComponent(reason)}`);
}

function pickFields(formData: FormData) {
  return {
    date: String(formData.get("date") ?? "").trim(),
    storeId: String(formData.get("store") ?? "").trim() || null,
    revenueType: String(formData.get("revenue_type") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || null,
    amount: Number(String(formData.get("amount") ?? "")),
    notes: String(formData.get("notes") ?? "").trim() || null,
  };
}

function validate(f: ReturnType<typeof pickFields>) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) bad("invalid_date");
  if (!VALID_TYPES.has(f.revenueType)) bad("invalid_type");
  if (!Number.isFinite(f.amount) || f.amount <= 0) bad("invalid_amount");
}

export async function submitManualRevenueAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/revenue");
  const tenant = await getCurrentTenant(auth);

  const f = pickFields(formData);
  validate(f);

  const sb = supabaseAdmin();
  const { error } = await sb.from("manual_revenue_entries").insert({
    tenant_id: tenant.id,
    store_id: f.storeId,
    date: f.date,
    revenue_type: f.revenueType,
    description: f.description,
    amount: Math.round(f.amount * 100) / 100,
    notes: f.notes,
    created_by: user.id,
  });
  if (error) bad(`db:${error.message.slice(0, 60)}`);

  revalidatePath("/revenue");
  revalidatePath("/");
  redirect(
    `/revenue?ok=${encodeURIComponent(`logged $${f.amount.toFixed(2)} ${f.revenueType}`)}`,
  );
}

export async function updateManualRevenueAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/revenue");
  const tenant = await getCurrentTenant(auth);

  const id = String(formData.get("id") ?? "");
  if (!id) bad("missing_id");

  const f = pickFields(formData);
  validate(f);

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("manual_revenue_entries")
    .update({
      store_id: f.storeId,
      date: f.date,
      revenue_type: f.revenueType,
      description: f.description,
      amount: Math.round(f.amount * 100) / 100,
      notes: f.notes,
    })
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (error) bad(`db:${error.message.slice(0, 60)}`);

  revalidatePath("/revenue");
  revalidatePath("/");
  redirect(`/revenue?ok=${encodeURIComponent("entry updated")}`);
}

export async function deleteManualRevenueAction(formData: FormData) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login?next=/revenue");
  const tenant = await getCurrentTenant(auth);

  const id = String(formData.get("id") ?? "");
  if (!id) bad("missing_id");

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("manual_revenue_entries")
    .delete()
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (error) bad(`db:${error.message.slice(0, 60)}`);

  revalidatePath("/revenue");
  revalidatePath("/");
  redirect(`/revenue?ok=${encodeURIComponent("entry deleted")}`);
}

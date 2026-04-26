"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Sets the tenant's display_name from the onboarding form and lands the
 *  user on the dashboard. */
export async function completeOnboardingAction(formData: FormData) {
  const ssr = await createSupabaseServerClient();
  const {
    data: { user },
  } = await ssr.auth.getUser();
  if (!user) redirect("/login");

  const displayName = String(formData.get("display_name") ?? "").trim();
  if (!displayName) redirect("/onboarding?err=name");

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("tenants")
    .update({
      display_name: displayName.slice(0, 120),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);
  if (error) redirect("/onboarding?err=db");

  redirect("/");
}

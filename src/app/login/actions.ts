"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/") || "/";

  if (!email || !password) {
    redirect(`/login?err=missing&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?err=bad&next=${encodeURIComponent(next)}`);
  }

  redirect(next.startsWith("/") ? next : "/");
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/** Creates a new account. The Postgres trigger added in migration 011
 *  fires on the auth.users insert and provisions a tenants row. After
 *  signup we land the user on /onboarding so they can set their business
 *  name (the trigger seeds it from the email's local part as a fallback). */
export async function signUpAction(formData: FormData) {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    redirect("/signup?err=missing");
  }
  if (password.length < 8) {
    redirect("/signup?err=short");
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signUp({ email, password });

  if (error) {
    redirect(`/signup?err=${encodeURIComponent(error.message).slice(0, 200)}`);
  }

  redirect("/onboarding");
}

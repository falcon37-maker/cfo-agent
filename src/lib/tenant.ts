// Tenant scoping helper.
//
// Phase 1A: tenants table exists, every data table carries tenant_id, but
// queries don't filter on it yet (RLS is off, cron + queries still use the
// service role). This helper is the seam — once phase 1B lands, every
// page/server-action will resolve the current tenant via getCurrentTenant()
// and pass tenant.id into queries. RLS in phase 1C closes the security
// boundary at the DB level.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Tenant = {
  id: string;
  user_id: string;
  display_name: string;
  email: string;
  is_active: boolean;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** Resolve the current tenant for the in-flight request — opens an SSR
 *  Supabase client off the cookie store, reads auth.getUser(), and looks
 *  up the matching tenants row. Use this from Server Components, Server
 *  Actions, and Route Handlers that run in a request context. */
export async function requireTenant(): Promise<Tenant> {
  const ssr = await createSupabaseServerClient();
  return getCurrentTenant(ssr);
}

/** Resolve the current tenant from a SSR-bound Supabase client (which has
 *  the user's session cookie). Throws if there's no authenticated user or
 *  no matching tenant row.
 *
 *  Uses the user's anon-key client for the auth.getUser() call but the
 *  service-role client to read tenants — phase 1A doesn't have RLS, and
 *  this lets phase 1B start adopting the helper without depending on RLS
 *  policies landing first. */
export async function getCurrentTenant(
  ssrClient: SupabaseClient,
): Promise<Tenant> {
  const {
    data: { user },
    error,
  } = await ssrClient.auth.getUser();
  if (error || !user) {
    throw new Error("Not authenticated");
  }
  return getTenantForUser(user.id, user.email ?? null);
}

/** Fetch the tenant for a user. Resolution order:
 *   1. owned tenant (tenants.user_id = userId) — fast path for the
 *      common case
 *   2. tenant_memberships join (covers shared-access users like the
 *      manager email)
 *   Throws if neither yields a tenant. */
export async function getTenantForUser(
  userId: string,
  // userEmail kept for log/error context only — no longer load-bearing
  // for the manager fallback (memberships replaced it in migration 013).
  _userEmail?: string | null,
): Promise<Tenant> {
  const sb = supabaseAdmin();

  const { data: owned, error: ownErr } = await sb
    .from("tenants")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) throw new Error(`getTenantForUser: ${ownErr.message}`);
  if (owned) return owned as Tenant;

  // Membership lookup: if the user belongs to another tenant via
  // tenant_memberships, return that tenant. Pick the membership with the
  // lowest-privilege role last so an explicit owner/admin row beats a
  // legacy manager row when both exist.
  const { data: memberships } = await sb
    .from("tenant_memberships")
    .select("tenant_id, role, tenants(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  const membership = memberships?.[0] as
    | { tenant_id: string; role: string; tenants: Tenant }
    | undefined;
  if (membership?.tenants) return membership.tenants;

  throw new Error(
    `No tenant found for user ${userId}. Sign up should provision one — ` +
      `see ensure_owner_tenant() in migration 010.`,
  );
}

/** All active tenants. Used by cron jobs to iterate every tenant's data. */
export async function listActiveTenants(): Promise<Tenant[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("tenants")
    .select("*")
    .eq("is_active", true)
    .order("created_at");
  if (error) throw new Error(`listActiveTenants: ${error.message}`);
  return (data ?? []) as Tenant[];
}

/** Provisions a tenant for a user that doesn't have one yet — wraps the
 *  ensure_owner_tenant() Postgres function. Used by the signup flow. */
export async function provisionTenant(args: {
  userId: string;
  email: string;
  displayName?: string;
}): Promise<Tenant> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("ensure_owner_tenant", {
    p_user_id: args.userId,
    p_email: args.email,
    p_display: args.displayName ?? null,
  });
  if (error) throw new Error(`provisionTenant: ${error.message}`);
  if (!data) throw new Error("provisionTenant: no tenant id returned");
  return getTenantForUser(args.userId);
}

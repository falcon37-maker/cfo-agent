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

/** Fetch the tenant for a user. Resolution rules:
 *
 *   1. Read every tenant_memberships row for the user.
 *   2. If any row has a non-'owner' role (admin / manager / viewer), that's
 *      shared access into someone else's workspace — return that tenant.
 *      It beats the user's own auto-provisioned tenant from the signup
 *      trigger. Multi-shared-tenant ordering: prefer admin > manager >
 *      viewer; ties broken by membership creation time.
 *   3. Otherwise return the 'owner' membership's tenant (the user's
 *      personal workspace).
 *   4. If memberships is empty (e.g. an old user before migration 013
 *      backfilled), fall back to the legacy tenants.user_id lookup. */
export async function getTenantForUser(
  userId: string,
  // userEmail unused now — left on the signature for compatibility with
  // existing callers; resolution goes through memberships.
  _userEmail?: string | null,
): Promise<Tenant> {
  const sb = supabaseAdmin();

  type MembershipRow = { role: string; created_at: string; tenants: Tenant };
  const { data: memberships, error: memErr } = await sb
    .from("tenant_memberships")
    .select("role, created_at, tenants(*)")
    .eq("user_id", userId);

  if (!memErr && memberships && memberships.length > 0) {
    const rows = memberships as unknown as MembershipRow[];
    const RANK: Record<string, number> = {
      admin: 0,
      manager: 1,
      viewer: 2,
      owner: 3,
    };
    rows.sort((a, b) => {
      const ra = RANK[a.role] ?? 9;
      const rb = RANK[b.role] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.created_at.localeCompare(b.created_at);
    });
    const winner = rows[0];
    if (winner?.tenants) return winner.tenants;
  }

  // Legacy fallback when memberships is empty / table missing.
  const { data: owned, error: ownErr } = await sb
    .from("tenants")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) throw new Error(`getTenantForUser: ${ownErr.message}`);
  if (owned) return owned as Tenant;

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

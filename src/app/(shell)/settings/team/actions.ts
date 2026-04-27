"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireTenant } from "@/lib/tenant";

const VALID_ROLES = new Set(["admin", "manager", "viewer"]);

function bad(reason: string): never {
  redirect(`/settings/team?err=${encodeURIComponent(reason)}`);
}

/** Invite a teammate by email. If they have an auth.users row already,
 *  we create a tenant_memberships row directly. Otherwise we drop a
 *  pending_invitations row that the signup trigger consumes. */
export async function inviteTeammateAction(formData: FormData) {
  const tenant = await requireTenant();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "").trim();

  if (!email || !email.includes("@")) bad("invalid_email");
  if (!VALID_ROLES.has(role)) bad("invalid_role");

  const sb = supabaseAdmin();

  // Check if the user already exists. We use the admin auth API since
  // user lookups by email aren't accessible via the public schema.
  const { data: usersList } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const existing = usersList?.users.find(
    (u) => u.email?.toLowerCase() === email,
  );

  if (existing) {
    // Direct membership insert.
    const { error } = await sb
      .from("tenant_memberships")
      .upsert(
        { tenant_id: tenant.id, user_id: existing.id, role },
        { onConflict: "tenant_id,user_id" },
      );
    if (error) bad(`db:${error.message.slice(0, 60)}`);
    revalidatePath("/settings/team");
    redirect(`/settings/team?ok=${encodeURIComponent(`added ${email}`)}`);
  }

  // No auth.users row yet — drop a pending invite.
  const { error: pErr } = await sb.from("pending_invitations").upsert(
    { tenant_id: tenant.id, email, role, invited_by: tenant.user_id },
    { onConflict: "tenant_id,email" },
  );
  if (pErr) bad(`db:${pErr.message.slice(0, 60)}`);
  revalidatePath("/settings/team");
  redirect(`/settings/team?ok=${encodeURIComponent(`invited ${email}`)}`);
}

export async function removeMembershipAction(formData: FormData) {
  const tenant = await requireTenant();
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) bad("missing_user");

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("tenant_memberships")
    .delete()
    .eq("tenant_id", tenant.id)
    .eq("user_id", userId);
  if (error) bad(`db:${error.message.slice(0, 60)}`);
  revalidatePath("/settings/team");
  redirect(`/settings/team?ok=${encodeURIComponent("removed")}`);
}

export async function cancelInvitationAction(formData: FormData) {
  const tenant = await requireTenant();
  const inviteId = String(formData.get("invite_id") ?? "");
  if (!inviteId) bad("missing_invite");

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("pending_invitations")
    .delete()
    .eq("tenant_id", tenant.id)
    .eq("id", inviteId);
  if (error) bad(`db:${error.message.slice(0, 60)}`);
  revalidatePath("/settings/team");
  redirect(`/settings/team?ok=${encodeURIComponent("invite cancelled")}`);
}

export async function changeRoleAction(formData: FormData) {
  const tenant = await requireTenant();
  const userId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!userId) bad("missing_user");
  if (!VALID_ROLES.has(role) && role !== "owner") bad("invalid_role");

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("tenant_memberships")
    .update({ role })
    .eq("tenant_id", tenant.id)
    .eq("user_id", userId);
  if (error) bad(`db:${error.message.slice(0, 60)}`);
  revalidatePath("/settings/team");
  redirect(`/settings/team?ok=${encodeURIComponent(`role updated`)}`);
}

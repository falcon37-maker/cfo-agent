import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireTenant } from "@/lib/tenant";
import { fmtDate } from "@/lib/format";
import {
  inviteTeammateAction,
  removeMembershipAction,
  cancelInvitationAction,
} from "./actions";
import { CheckCircle2, AlertCircle, UserPlus, X } from "lucide-react";

export const dynamic = "force-dynamic";

const ERR_MAP: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  invalid_role: "Pick a valid role.",
  missing_user: "Missing user.",
  missing_invite: "Missing invitation.",
};

const ROLE_DESC: Record<string, string> = {
  owner: "Full access · created the workspace",
  admin: "Full access · can manage team & integrations",
  manager: "Read all · can log COGS & ad spend",
  viewer: "Read-only access",
};

type MembershipRow = {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
};

type InviteRow = {
  id: string;
  email: string;
  role: string;
  created_at: string;
};

async function loadTeam(tenantId: string): Promise<{
  members: Array<MembershipRow & { email: string | null }>;
  invites: InviteRow[];
}> {
  const sb = supabaseAdmin();
  const [{ data: memberships }, { data: invites }] = await Promise.all([
    sb
      .from("tenant_memberships")
      .select("id, user_id, role, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at"),
    sb
      .from("pending_invitations")
      .select("id, email, role, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
  ]);
  // Look up emails for each user_id via the admin auth API.
  const userIds = (memberships ?? []).map((m) => m.user_id);
  const emails = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: usersList } = await sb.auth.admin.listUsers({ perPage: 1000 });
    for (const u of usersList?.users ?? []) {
      if (u.email && userIds.includes(u.id)) emails.set(u.id, u.email);
    }
  }
  return {
    members: (memberships ?? []).map((m) => ({
      ...m,
      email: emails.get(m.user_id) ?? null,
    })) as Array<MembershipRow & { email: string | null }>,
    invites: (invites ?? []) as InviteRow[],
  };
}

export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const params = await searchParams;
  const tenant = await requireTenant();
  const { members, invites } = await loadTeam(tenant.id);

  const errMessage = params.err
    ? (ERR_MAP[params.err] ?? params.err)
    : null;

  return (
    <>
      {params.ok ? (
        <div className="inline-banner banner-pos" style={{ marginBottom: 12 }}>
          <CheckCircle2 size={14} strokeWidth={2} />
          {decodeURIComponent(params.ok)}
        </div>
      ) : null}
      {errMessage ? (
        <div className="inline-banner banner-neg" style={{ marginBottom: 12 }}>
          <AlertCircle size={14} strokeWidth={2} />
          {errMessage}
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Team</div>
            <div className="card-sub">
              {members.length} member{members.length === 1 ? "" : "s"}
              {invites.length > 0 ? ` · ${invites.length} pending invite${invites.length === 1 ? "" : "s"}` : ""}
            </div>
          </div>
        </div>

        <form
          action={inviteTeammateAction}
          style={{
            padding: "16px 18px",
            display: "grid",
            gridTemplateColumns: "1fr 160px auto",
            gap: 10,
            alignItems: "end",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <label className="field" style={{ margin: 0 }}>
            <span className="field-label">Email</span>
            <div className="field-input">
              <input
                type="email"
                name="email"
                required
                placeholder="lara@example.com"
              />
            </div>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span className="field-label">Role</span>
            <div className="field-input">
              <select name="role" defaultValue="manager">
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
          </label>
          <button type="submit" className="primary-btn">
            <UserPlus size={13} strokeWidth={2} />
            Invite
          </button>
        </form>

        <div className="table-wrap">
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.email ?? <span className="muted">unknown user</span>}
                  </td>
                  <td title={ROLE_DESC[m.role]}>{m.role}</td>
                  <td className="muted">{fmtDate(m.created_at.slice(0, 10))}</td>
                  <td>
                    {m.role !== "owner" ? (
                      <form action={removeMembershipAction} style={{ display: "inline" }}>
                        <input type="hidden" name="user_id" value={m.user_id} />
                        <button
                          type="submit"
                          className="ghost-btn"
                          style={{ fontSize: 11, color: "var(--negative)" }}
                        >
                          <X size={13} strokeWidth={2} /> Remove
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
              {invites.map((i) => (
                <tr key={i.id} style={{ opacity: 0.7 }}>
                  <td>
                    {i.email}{" "}
                    <span
                      className="status-pill status-warn"
                      style={{ marginLeft: 6, fontSize: 10 }}
                    >
                      <span className="pill-dot" />
                      Pending
                    </span>
                  </td>
                  <td className="muted">{i.role}</td>
                  <td className="muted">
                    invited {fmtDate(i.created_at.slice(0, 10))}
                  </td>
                  <td>
                    <form
                      action={cancelInvitationAction}
                      style={{ display: "inline" }}
                    >
                      <input type="hidden" name="invite_id" value={i.id} />
                      <button
                        type="submit"
                        className="ghost-btn"
                        style={{ fontSize: 11 }}
                      >
                        Cancel
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// Edit-mode gate.
//
// Edit-mode is OFF by default. The user must explicitly turn it on per
// request (UI toggle in chat header → sends `edit_mode: true` in the
// POST body). When OFF, the model's edit tools are not even exposed —
// it doesn't know they exist for that turn.
//
// When ON, edit tools are exposed AND the model is told that every
// write still requires user confirmation (confirm-first flow).
//
// Why per-request and not session-sticky:
//   - Reduces accidental edits when the user toggles edit-mode for one
//     correction and forgets to turn it off.
//   - Makes the audit log cleaner — every edit ties to a turn where the
//     user explicitly enabled it.
//
// Role gate:
//   - owner, admin, manager → may use edit-mode
//   - viewer → may NOT (we strip the flag server-side)

import type { TenantRole } from "@/lib/tenant";

/** Roles allowed to flip edit-mode on. */
const EDIT_ALLOWED_ROLES: TenantRole[] = ["owner", "admin", "manager"];

export function canUseEditMode(role: TenantRole): boolean {
  return EDIT_ALLOWED_ROLES.includes(role);
}

/** Final resolution: the per-request flag AND the role gate. The route
 *  handler treats the result as authoritative. */
export function resolveEditMode(args: {
  requested: boolean;
  role: TenantRole;
}): { active: boolean; reason: string | null } {
  if (!args.requested) {
    return { active: false, reason: null };
  }
  if (!canUseEditMode(args.role)) {
    return {
      active: false,
      reason: "Your role doesn't allow edits. Ask an admin to make changes.",
    };
  }
  return { active: true, reason: null };
}

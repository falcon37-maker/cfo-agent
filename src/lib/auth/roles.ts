// Role-based access. Phase 1: two roles, hardcoded by email. Replace with a
// `user_profiles` table + RLS when we have more than a handful of users.

export type Role = "admin" | "manager";

/**
 * Managers are restricted to /cogs only. Any non-manager authenticated user
 * is treated as an admin with full access. Email matches are case-insensitive.
 */
const MANAGER_EMAILS = new Set(["manager@shoppingecom.com"]);

export function getRole(email: string | null | undefined): Role {
  if (email && MANAGER_EMAILS.has(email.toLowerCase())) return "manager";
  return "admin";
}

/**
 * Returns true if `role` may access the given pathname. Managers only get
 * /cogs (and auth routes, always). Admins get everything.
 */
export function canAccess(role: Role, pathname: string): boolean {
  if (role === "admin") return true;

  // Manager allow-list
  if (pathname === "/cogs" || pathname.startsWith("/cogs/")) return true;
  // Auth-related paths are always allowed so sign-out/redirects work.
  if (pathname === "/login" || pathname.startsWith("/auth/")) return true;
  return false;
}

/** Where a role's users land after sign-in when no explicit `next` is set. */
export function defaultHome(role: Role): string {
  return role === "manager" ? "/cogs" : "/";
}

// Resolve a remote-MCP bearer token → tenant. Claude Desktop / Claude.ai has no
// browser session, so the MCP server is authenticated purely by this token (NOT
// requireTenant(), which reads the SSR cookie). Every lib function is already
// tenant-scoped by its tenantId argument, so this is the only isolation needed.

import { supabaseAdmin } from "@/lib/supabase/admin";

export async function resolveMcpToken(
  token: string,
): Promise<{ tenantId: string; token: string } | null> {
  if (!token) return null;
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("mcp_tokens")
    .select("tenant_id, revoked_at")
    .eq("token", token)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;

  // Best-effort touch — don't fail the request if this update errors.
  await sb
    .from("mcp_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("token", token);

  return { tenantId: data.tenant_id as string, token };
}

// MCP token management + activity log helpers, used by the /settings/mcp UI and
// the MCP server. All queries scope by tenant_id via the service-role client.

import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type McpTokenRow = {
  token: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** Mint a new MCP token for a tenant. Returns the raw token (shown once). */
export async function mintToken(
  tenantId: string,
  label: string,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("mcp_tokens")
    .insert({ token, tenant_id: tenantId, label: label || "MCP connector" });
  if (error) throw new Error(`mintToken: ${error.message}`);
  return token;
}

/** All tokens for a tenant, newest first. Returns [] if the table doesn't
 *  exist yet (migration 026 not applied) so the page still renders. */
export async function listTokens(tenantId: string): Promise<McpTokenRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("mcp_tokens")
    .select("token, label, created_at, last_used_at, revoked_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`listTokens: ${error.message}`);
  }
  return (data ?? []) as McpTokenRow[];
}

/** Revoke a token (soft delete — keeps it in the audit trail). */
export async function revokeToken(
  tenantId: string,
  token: string,
): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("token", token);
  if (error) throw new Error(`revokeToken: ${error.message}`);
}

export type McpCallRow = {
  id: number;
  tool_name: string;
  arguments: Record<string, unknown> | null;
  ok: boolean;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
};

/** Record one tool call in the activity log. Best-effort — never throws into
 *  the MCP request path (a failed log must not fail the tool call). */
export async function logToolCall(entry: {
  tenantId: string;
  token: string;
  toolName: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
}): Promise<void> {
  try {
    const sb = supabaseAdmin();
    await sb.from("mcp_tool_calls").insert({
      tenant_id: entry.tenantId,
      token: entry.token,
      tool_name: entry.toolName,
      arguments: entry.args ?? {},
      ok: entry.ok,
      error: entry.error ?? null,
      duration_ms: entry.durationMs,
    });
  } catch {
    // swallow — logging must not break the tool call
  }
}

/** Recent activity for the settings history table. */
export async function listRecentCalls(
  tenantId: string,
  limit = 100,
): Promise<McpCallRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("mcp_tool_calls")
    .select("id, tool_name, arguments, ok, error, duration_ms, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`listRecentCalls: ${error.message}`);
  }
  return (data ?? []) as McpCallRow[];
}

/** True when the error is "relation/table not found" — i.e. the migration
 *  hasn't been applied yet. Postgres code 42P01; PostgREST reports PGRST205. */
function isMissingTable(err: { code?: string; message?: string }): boolean {
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /schema cache|does not exist|could not find the table/i.test(err.message ?? "")
  );
}

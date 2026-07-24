// Thin OAuth 2.0 authorization-code + PKCE facade for the MCP connector.
//
// Claude.ai's "Connect" flow will not use a token supplied in the connector
// URL — it insists on an OAuth handshake with dynamic client registration. So
// we present a minimal, spec-shaped OAuth server whose only job is to hand the
// caller back the tenant's existing mcp_token as the access_token:
//
//   /.well-known/oauth-authorization-server  → endpoint discovery
//   /oauth/register                          → DCR (accepts any client)
//   /oauth/authorize                         → auto-approve via Supabase session,
//                                              issues a code bound to the tenant
//   /oauth/token                             → code + PKCE → mcp_token
//
// The issued access_token IS an mcp_token, so the existing resolveMcpToken()
// in src/lib/mcp/auth.ts validates it unchanged — no MCP-server changes needed.

import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { mintToken } from "@/lib/mcp/tokens";

/** Auth codes are single-use and short-lived. */
const CODE_TTL_MS = 5 * 60 * 1000;

/** Base64url without padding — the encoding PKCE (RFC 7636) uses. */
function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Verify a PKCE S256 challenge against the verifier the client presents. */
export function verifyPkce(
  verifier: string,
  challenge: string | null,
  method: string | null,
): boolean {
  // No challenge was stored (client didn't use PKCE) — allow, since our codes
  // are already single-use, session-bound, and short-lived.
  if (!challenge) return true;
  if (method && method !== "S256") return false;
  const computed = b64url(createHash("sha256").update(verifier).digest());
  return computed === challenge;
}

/** Reuse the tenant's most recent live MCP token, or mint one if none exists.
 *  Keeps re-connecting from issuing an unbounded pile of tokens. */
export async function getOrMintTenantToken(
  tenantId: string,
): Promise<string> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("mcp_tokens")
    .select("token")
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.token) return data.token as string;
  return mintToken(tenantId, "Claude connector (OAuth)");
}

export type NewCodeArgs = {
  tenantId: string;
  mcpToken: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
};

/** Persist a fresh authorization code and return it. */
export async function createAuthCode(args: NewCodeArgs): Promise<string> {
  const code = randomBytes(32).toString("hex");
  const sb = supabaseAdmin();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const { error } = await sb.from("mcp_oauth_codes").insert({
    code,
    mcp_token: args.mcpToken,
    tenant_id: args.tenantId,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code_challenge: args.codeChallenge,
    code_challenge_method: args.codeChallengeMethod,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`createAuthCode: ${error.message}`);
  return code;
}

export type ConsumedCode = {
  mcpToken: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
};

/** Atomically consume a code: returns its payload if valid+unused+unexpired,
 *  else null. Marks it consumed so it can't be replayed. */
export async function consumeAuthCode(
  code: string,
): Promise<ConsumedCode | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("mcp_oauth_codes")
    .select(
      "mcp_token, redirect_uri, code_challenge, code_challenge_method, expires_at, consumed_at",
    )
    .eq("code", code)
    .maybeSingle();
  if (error || !data) return null;
  if (data.consumed_at) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;

  // Single-use: mark consumed. Guard on consumed_at still being null so two
  // concurrent exchanges can't both succeed.
  const { data: updated, error: updErr } = await sb
    .from("mcp_oauth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code", code)
    .is("consumed_at", null)
    .select("code")
    .maybeSingle();
  if (updErr || !updated) return null;

  return {
    mcpToken: data.mcp_token as string,
    redirectUri: data.redirect_uri as string,
    codeChallenge: (data.code_challenge as string | null) ?? null,
    codeChallengeMethod: (data.code_challenge_method as string | null) ?? null,
  };
}

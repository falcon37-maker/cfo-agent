// OAuth 2.0 Authorization endpoint (authorization-code + PKCE).
//
// This is the ONE browser-facing step of the MCP connector handshake. Claude
// redirects the user's browser here; because it's the user's browser, their
// Supabase session cookie is present, so we resolve the tenant the same way
// the rest of the app does (requireTenant → getCurrentTenant). We then:
//   1. get-or-mint that tenant's mcp_token,
//   2. store a one-time auth code bound to it (+ PKCE challenge),
//   3. redirect back to Claude's redirect_uri with ?code=...&state=...
//
// If the user isn't signed in, we bounce to /login?next=<this URL> so they
// authenticate and land back here to finish the grant.
//
// Exempted from Supabase's own auto-redirect: added to isPublic() in
// src/lib/supabase/middleware.ts (so WE control the login bounce, not it).

import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/tenant";
import { createAuthCode, getOrMintTenantToken } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Append a query param to a redirect_uri, preserving any it already has. */
function withParams(
  base: string,
  params: Record<string, string | undefined>,
): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.toString();
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;

  const responseType = params.get("response_type");
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? undefined;
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");

  // A redirect_uri is required to report anything back. Without one, fail hard.
  if (!redirectUri) {
    return new Response("missing redirect_uri", { status: 400 });
  }
  // We only implement the authorization-code flow.
  if (responseType !== "code") {
    return Response.redirect(
      withParams(redirectUri, {
        error: "unsupported_response_type",
        state,
      }),
      302,
    );
  }

  // Resolve the tenant from the user's Supabase session (requireTenant reads
  // the SSR cookie; it also honours the dev-only x-test-user-id bypass so this
  // endpoint is testable without a browser). If unauthenticated, bounce to
  // /login and return to this exact URL afterwards.
  let tenantId: string;
  try {
    const tenant = await requireTenant();
    tenantId = tenant.id;
  } catch {
    const next = url.pathname + url.search;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  // Auto-approve: mint/reuse the tenant token and bind a one-time code to it.
  const mcpToken = await getOrMintTenantToken(tenantId);
  const code = await createAuthCode({
    tenantId,
    mcpToken,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
  });

  return Response.redirect(withParams(redirectUri, { code, state }), 302);
}

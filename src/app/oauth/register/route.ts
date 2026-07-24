// OAuth 2.0 Dynamic Client Registration (RFC 7591) — minimal.
//
// Claude.ai registers a client here before the authorize step. We run PKCE
// public clients (no secret), so registration is stateless: we accept whatever
// the client sends, echo back a generated client_id, and reflect its
// redirect_uris. The /oauth/authorize + /oauth/token steps enforce the actual
// security (session-bound codes, single use, PKCE, redirect_uri match).
//
// Exempted from Supabase auth: this path is added to isPublic() in
// src/lib/supabase/middleware.ts so it isn't redirected to /login.

import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "*",
};

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty / non-JSON body is fine — we accept any client.
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as string[])
    : [];
  const clientId = `mcp-${randomBytes(16).toString("hex")}`;

  return Response.json(
    {
      client_id: clientId,
      // Public PKCE client: no secret issued.
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: redirectUris,
    },
    { status: 201, headers: CORS },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

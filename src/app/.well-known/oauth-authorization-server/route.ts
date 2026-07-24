// OAuth 2.0 Authorization Server Metadata (RFC 8414).
//
// Advertises our minimal OAuth facade so Claude.ai's connector can complete
// dynamic client registration + the authorization-code + PKCE handshake. See
// src/lib/mcp/oauth.ts for the flow. Exempted from Supabase auth via the
// /.well-known/ prefix in src/lib/supabase/middleware.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "*",
    },
  });
}

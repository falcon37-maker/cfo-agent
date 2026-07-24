// OAuth 2.0 Protected Resource Metadata (RFC 9728).
//
// Claude.ai's MCP "Connect" flow fetches this first to discover how to
// authenticate against our /mcp endpoint. We use a static pre-shared bearer
// token (supplied in the connector URL as ?token=...), NOT an interactive
// OAuth grant — so we deliberately do NOT advertise an `authorization_servers`
// entry. Omitting it stops the client from chasing a nonexistent
// authorization-server handshake; it just uses the bearer token it already has.
//
// NOTE: this path is exempted from Supabase auth in src/lib/supabase/middleware.ts
// (the /.well-known/ prefix) so it returns JSON instead of a 307 to /login.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  return Response.json(
    {
      resource: `${origin}/mcp`,
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    },
    {
      headers: {
        // Discovery must be readable cross-origin by the connector UI.
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

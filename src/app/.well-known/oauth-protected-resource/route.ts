// OAuth 2.0 Protected Resource Metadata (RFC 9728).
//
// Claude.ai's MCP "Connect" flow fetches this first to discover how to
// authenticate against our /mcp endpoint. It points the client at our own
// origin as the authorization server; the client then reads
// /.well-known/oauth-authorization-server and runs the OAuth handshake there.
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
      authorization_servers: [origin],
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

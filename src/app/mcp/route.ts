// Remote MCP endpoint — https://<host>/mcp
//
// Claude Desktop / Claude.ai connects here as a connector using a URL + bearer
// token. We resolve the token → tenant, then hand the request to the per-tenant
// MCP server (tools defined in src/lib/mcp/server.ts). All data is isolated by
// the token's tenant; the model never supplies one.

import { resolveMcpToken } from "@/lib/mcp/auth";
import { handleMcpRequest } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sync tools call live provider APIs (Paysight/Phoenix/Shopify) that can take
// 15-60s. Without this, Vercel's ~10s default would kill those requests and
// the connector would look broken. 300s gives ample headroom.
export const maxDuration = 300;

async function handle(req: Request): Promise<Response> {
  // Token can arrive two ways:
  //   1. Authorization: Bearer <token>   (standard MCP clients)
  //   2. ?token=<token> in the URL        (Claude Desktop's custom-connector
  //      dialog only has a URL field — no place for a header — so we accept
  //      the token as a query param too).
  const auth = req.headers.get("authorization") ?? "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const queryToken = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  const token = headerToken || queryToken;
  const resolved = await resolveMcpToken(token);
  if (!resolved) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="cfo-agent-mcp"',
        },
      },
    );
  }
  return handleMcpRequest(req, resolved.tenantId, resolved.token);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

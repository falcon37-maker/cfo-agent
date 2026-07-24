// OAuth 2.0 Token endpoint — authorization_code grant with PKCE.
//
// Claude exchanges the code from /oauth/authorize here. We validate the code
// (single-use, unexpired, redirect_uri match, PKCE verifier), then return the
// tenant's mcp_token AS the access_token. That token is what /mcp already
// accepts via resolveMcpToken(), so no MCP-server changes are needed.
//
// Exempted from Supabase auth via isPublic() in src/lib/supabase/middleware.ts.

import { consumeAuthCode, verifyPkce } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "*",
};

function err(code: string, status = 400): Response {
  return Response.json({ error: code }, { status, headers: CORS });
}

export async function POST(req: Request): Promise<Response> {
  // Token requests are form-encoded per RFC 6749, but accept JSON too.
  let fields: Record<string, string> = {};
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      fields = (await req.json()) as Record<string, string>;
    } else {
      const form = await req.formData();
      for (const [k, v] of form.entries()) fields[k] = String(v);
    }
  } catch {
    return err("invalid_request");
  }

  if (fields.grant_type !== "authorization_code") {
    return err("unsupported_grant_type");
  }
  const code = fields.code;
  const redirectUri = fields.redirect_uri;
  const verifier = fields.code_verifier;
  if (!code || !redirectUri) return err("invalid_request");

  const consumed = await consumeAuthCode(code);
  if (!consumed) return err("invalid_grant");

  // The redirect_uri presented here must match the one the code was issued for.
  if (consumed.redirectUri !== redirectUri) return err("invalid_grant");

  // PKCE: if a challenge was recorded, the verifier must satisfy it.
  if (consumed.codeChallenge) {
    if (!verifier) return err("invalid_request");
    if (
      !verifyPkce(
        verifier,
        consumed.codeChallenge,
        consumed.codeChallengeMethod,
      )
    ) {
      return err("invalid_grant");
    }
  }

  return Response.json(
    {
      access_token: consumed.mcpToken,
      token_type: "Bearer",
      scope: "mcp",
    },
    { headers: { ...CORS, "cache-control": "no-store" } },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

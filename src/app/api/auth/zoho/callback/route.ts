// GET /api/auth/zoho/callback — Zoho redirects here after the user consents.
// Verifies state, exchanges the one-time code for access + refresh tokens,
// persists them, and bounces the user back to /settings/integrations.

import { NextRequest, NextResponse } from "next/server";
import { saveCredentials, zohoEnv } from "@/lib/zoho/tokens";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";

export async function GET(req: NextRequest) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = zohoEnv();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectBack(req, `zoho_error=${encodeURIComponent(error)}`);
  }
  if (!code) return redirectBack(req, "zoho_error=missing_code");

  const expectedState = req.cookies.get("zoho_oauth_state")?.value;
  if (!state || !expectedState || state !== expectedState) {
    return redirectBack(req, "zoho_error=state_mismatch");
  }

  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    return redirectBack(
      req,
      `zoho_error=${encodeURIComponent(`exchange_${res.status}:${text.slice(0, 120)}`)}`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (json.error || !json.access_token || !json.refresh_token) {
    return redirectBack(
      req,
      `zoho_error=${encodeURIComponent(json.error ?? "no_tokens_returned")}`,
    );
  }

  const tenant = await requireTenant();
  await saveCredentials(
    tenant.id,
    json.access_token,
    json.refresh_token,
    json.expires_in ?? 3600,
  );

  const response = redirectBack(req, "zoho_connected=1");
  response.cookies.delete("zoho_oauth_state");
  return response;
}

function redirectBack(req: NextRequest, query: string): NextResponse {
  const origin = new URL(req.url).origin;
  return NextResponse.redirect(`${origin}/settings/integrations?${query}`);
}

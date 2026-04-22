// GET /api/auth/zoho — kicks off the Zoho OAuth consent flow.
// Generates a random `state` token stored in a short-lived httpOnly cookie
// so the /callback route can verify the redirect actually came from us.

import { NextResponse } from "next/server";
import { zohoEnv } from "@/lib/zoho/tokens";

export const dynamic = "force-dynamic";

const AUTH_URL = "https://accounts.zoho.com/oauth/v2/auth";
const SCOPES = "ZohoBooks.fullaccess.all";

export async function GET() {
  const { CLIENT_ID, REDIRECT_URI } = zohoEnv();
  if (!CLIENT_ID || !REDIRECT_URI) {
    return NextResponse.json(
      { error: "ZOHO_CLIENT_ID or ZOHO_REDIRECT_URI not set" },
      { status: 500 },
    );
  }

  const state = crypto.randomUUID();
  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("access_type", "offline");
  // Zoho only returns a refresh_token the first time unless prompt=consent.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set("zoho_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 min
    path: "/",
  });
  return res;
}

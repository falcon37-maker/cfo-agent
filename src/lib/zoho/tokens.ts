// Token store + refresh. Single-tenant: one row per org_id in `zoho_credentials`.
// Access tokens expire in ~1h; refresh_token is long-lived (revocable in Zoho admin).

import { supabaseAdmin } from "@/lib/supabase/admin";

const ORG_ID = process.env.ZOHO_ORG_ID ?? "";
const CLIENT_ID = process.env.ZOHO_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET ?? "";
const TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";

// Buffer so we don't race a request against token expiry.
const EARLY_REFRESH_MS = 60_000;

export type ZohoCredentials = {
  org_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
};

export async function loadCredentials(): Promise<ZohoCredentials | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("zoho_credentials")
    .select("org_id, access_token, refresh_token, expires_at")
    .eq("org_id", ORG_ID)
    .maybeSingle();
  if (error) throw new Error(`loadCredentials: ${error.message}`);
  return (data as ZohoCredentials) ?? null;
}

export async function saveCredentials(
  access_token: string,
  refresh_token: string,
  expires_in_seconds: number,
): Promise<void> {
  const sb = supabaseAdmin();
  const expires_at = new Date(Date.now() + expires_in_seconds * 1000).toISOString();
  const { error } = await sb
    .from("zoho_credentials")
    .upsert(
      {
        org_id: ORG_ID,
        access_token,
        refresh_token,
        expires_at,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" },
    );
  if (error) throw new Error(`saveCredentials: ${error.message}`);
}

/** Update only the access_token (keeps refresh_token untouched). */
async function patchAccessToken(
  access_token: string,
  expires_in_seconds: number,
): Promise<void> {
  const sb = supabaseAdmin();
  const expires_at = new Date(Date.now() + expires_in_seconds * 1000).toISOString();
  const { error } = await sb
    .from("zoho_credentials")
    .update({ access_token, expires_at, updated_at: new Date().toISOString() })
    .eq("org_id", ORG_ID);
  if (error) throw new Error(`patchAccessToken: ${error.message}`);
}

export async function deleteCredentials(): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("zoho_credentials")
    .delete()
    .eq("org_id", ORG_ID);
  if (error) throw new Error(`deleteCredentials: ${error.message}`);
}

function isExpired(creds: ZohoCredentials): boolean {
  return Date.parse(creds.expires_at) - Date.now() < EARLY_REFRESH_MS;
}

/**
 * Returns a valid access_token — refreshes if expired. Throws if not connected.
 */
export async function getAccessToken(): Promise<string> {
  const creds = await loadCredentials();
  if (!creds) {
    throw new Error("Zoho not connected. Start OAuth at /api/auth/zoho.");
  }
  if (!isExpired(creds)) return creds.access_token;
  return refreshAccessToken(creds.refresh_token);
}

export async function refreshAccessToken(refresh_token: string): Promise<string> {
  const body = new URLSearchParams({
    refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho token refresh failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (json.error || !json.access_token) {
    throw new Error(`Zoho token refresh error: ${json.error ?? "no access_token"}`);
  }
  await patchAccessToken(json.access_token, json.expires_in ?? 3600);
  return json.access_token;
}

export function zohoEnv() {
  return {
    CLIENT_ID,
    CLIENT_SECRET,
    ORG_ID,
    REDIRECT_URI: process.env.ZOHO_REDIRECT_URI ?? "",
  };
}

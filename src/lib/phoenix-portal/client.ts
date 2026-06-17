// Phoenix Portal bulk-transactions API client.
//
// This is the FAST Phoenix path: one POST to /portal/api/transactions/get_details
// returns a whole day's transactions (vs the legacy per-customer
// transaction-history walk, which took ~40 min and hit 429s). It powers the
// daily cron + manual "Sync Now" for subscriptions.
//
// Auth: the portal uses a short-lived (~20 min) access_token that we renew
// from a 7-day rotating refresh_token via /portal/api/auth/refresh_token. The
// refresh_token ROTATES on every refresh, so we persist the new one back to
// the integrations table each time. Seed it once from the logged-in portal
// (localStorage.refresh_token) into integrations(provider='phoenix_portal').
//
// Billing definition (client spec Jun 2026): a subscription is "billed" only
// when the charge SETTLES — TransactionType Capture (or Direct Sale) with a
// non-failed response. Pre-Auth authorizations are NOT billed (salvage rows
// are Pre-Auth only and therefore don't count until/unless they capture). This
// matches Phoenix's own "Capture" transaction-type filter and the CSV export.

import { supabaseAdmin } from "@/lib/supabase/admin";
import { encrypt, decrypt, hasEncryptionKey } from "@/lib/crypto";

const PORTAL_BASE = "https://api.phoenixcrm.io/portal/api";
const REFRESH_PATH = "/auth/refresh_token";
const GET_DETAILS_PATH = "/transactions/get_details";

// Our Phoenix store ids → the portal numeric StoreIds we filter on. The portal
// accepts the full set; we map domains back to our stores after fetching.
const PORTAL_STORE_IDS = [1026, 1045, 1058, 1059, 1075, 1076, 1077];
const CLIENT_ID = 280;

const STORE_BY_DOMAIN: Record<string, string> = {
  "try.novasense-usa.store": "NOVA",
  "go.novasense-usa.store": "NOVA",
  "app.novasense-usa.store": "NOVA",
  "one.ross-usa.store": "NOVA",
  "nuracare.shop": "NURA",
  "kovacare.shop": "KOVA",
};

function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function portalStoreFromDomain(domain: string | null | undefined): string | null {
  return STORE_BY_DOMAIN[normalizeDomain(domain)] ?? null;
}

export type PortalTxn = {
  Date: string;
  Domain: string;
  Type: string; // "Vip Initial" | "1 Month" | "Month 1 Salvage" | "Direct" | ...
  TransactionType: string; // "Capture" | "Pre-Auth" | "Direct Sale" | "Refund" | "Void"
  Amount: string;
  CustomerId?: string | number;
  OrderId?: number;
  FailedTransaction?: boolean;
  ResponseMessage?: string;
};

// ─── Token management ─────────────────────────────────────────────────────

type PortalCreds = { refreshToken: string };

function isExpired(jwt: string, skewSec = 60): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf8"),
    );
    if (!payload?.exp) return true;
    return payload.exp * 1000 <= Date.now() + skewSec * 1000;
  } catch {
    return true;
  }
}

async function loadCreds(tenantId: string): Promise<PortalCreds | null> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("integrations")
    .select("credentials")
    .eq("tenant_id", tenantId)
    .eq("provider", "phoenix_portal")
    .maybeSingle();
  const enc = (data?.credentials as Record<string, unknown> | undefined) ?? {};
  const raw = enc.refreshToken;
  if (typeof raw !== "string" || !raw) return null;
  // Stored encrypted when an encryption key is configured; tolerate plaintext.
  let refreshToken = raw;
  if (hasEncryptionKey()) {
    try {
      refreshToken = decrypt(raw);
    } catch {
      refreshToken = raw; // was stored plaintext (seed) — use as-is
    }
  }
  return { refreshToken };
}

async function persistRefreshToken(
  tenantId: string,
  refreshToken: string,
): Promise<void> {
  const sb = supabaseAdmin();
  const stored = hasEncryptionKey() ? encrypt(refreshToken) : refreshToken;
  await sb
    .from("integrations")
    .update({
      credentials: { refreshToken: stored },
      last_synced_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .eq("provider", "phoenix_portal");
}

// In-memory access-token cache so a single sync run doesn't refresh repeatedly.
const accessTokenCache = new Map<string, string>();

/**
 * Return a valid access token for the tenant, refreshing (and rotating the
 * stored refresh token) when the cached one is missing/expired.
 */
async function getAccessToken(tenantId: string): Promise<string> {
  const cached = accessTokenCache.get(tenantId);
  if (cached && !isExpired(cached)) return cached;

  const creds = await loadCreds(tenantId);
  if (!creds) {
    throw new Error(
      "Phoenix portal not connected. Seed a refresh_token into " +
        "integrations(provider='phoenix_portal') from the logged-in portal.",
    );
  }

  const res = await fetch(`${PORTAL_BASE}${REFRESH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ RefreshToken: creds.refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Phoenix portal token refresh ${res.status}: ${body.slice(0, 200)}. ` +
        "The refresh_token may have expired (7-day life) — re-seed it.",
    );
  }
  const json = (await res.json()) as {
    AccessToken?: string;
    RefreshToken?: string;
  };
  if (!json.AccessToken) {
    throw new Error("Phoenix portal refresh returned no AccessToken");
  }
  // The refresh token rotates — persist the new one for next time.
  if (json.RefreshToken && json.RefreshToken !== creds.refreshToken) {
    await persistRefreshToken(tenantId, json.RefreshToken);
  }
  accessTokenCache.set(tenantId, json.AccessToken);
  return json.AccessToken;
}

// ─── Bulk transactions fetch ────────────────────────────────────────────────

/**
 * Fetch ALL transactions for a single day (store-local) from the portal,
 * paging through the result set. Returns raw rows; bucketing/billing rules are
 * applied by the caller (see phoenix-portal/sync.ts).
 */
export async function fetchDayTransactions(
  tenantId: string,
  day: string, // YYYY-MM-DD
): Promise<PortalTxn[]> {
  const token = await getAccessToken(tenantId);
  const all: PortalTxn[] = [];
  let page = 0;
  // Safety cap: a single day never exceeds a few thousand rows.
  for (; page < 40; page++) {
    const res = await fetch(`${PORTAL_BASE}${GET_DETAILS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Limit: 1000,
        Page: page,
        Search: {
          StartTime: day,
          EndTime: day,
          TransactionTypes: [
            "Direct Sale",
            "No Vault",
            "Pre-Auth",
            "Void",
            "Capture",
            "Refund",
          ],
          StoreIds: PORTAL_STORE_IDS,
          ClientIds: [CLIENT_ID],
        },
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Phoenix portal get_details ${res.status} (${day} p${page}): ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { Result?: PortalTxn[]; TotalCount?: number };
    const rows = json.Result ?? [];
    all.push(...rows);
    if (all.length >= (json.TotalCount ?? 0) || rows.length === 0) break;
  }
  return all;
}

/** True iff this tenant has a Phoenix-portal refresh token configured. */
export async function hasPhoenixPortalCreds(tenantId: string): Promise<boolean> {
  return (await loadCreds(tenantId)) !== null;
}

export type PortalHealth =
  | { status: "connected"; expiresInDays: number | null }
  | { status: "not_connected" }
  | { status: "expired"; reason: string }
  | { status: "error"; reason: string };

/**
 * Live health check for the Settings page: confirms the stored refresh_token
 * actually works by exchanging it once. "connected" only if the refresh
 * succeeds. Distinguishes "not_connected" (no token), "expired" (refresh
 * rejected — re-paste needed), and "error" (network/other).
 */
export async function checkPhoenixPortalHealth(
  tenantId: string,
): Promise<PortalHealth> {
  const creds = await loadCreds(tenantId);
  if (!creds) return { status: "not_connected" };

  let res: Response;
  try {
    res = await fetch(`${PORTAL_BASE}${REFRESH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ RefreshToken: creds.refreshToken }),
      cache: "no-store",
    });
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return {
      status: "expired",
      reason: `refresh rejected (${res.status}) — token expired, please reconnect`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { status: "error", reason: `${res.status}: ${body.slice(0, 120)}` };
  }

  const json = (await res.json().catch(() => null)) as {
    AccessToken?: string;
    RefreshToken?: string;
  } | null;
  if (!json?.AccessToken) {
    return { status: "expired", reason: "refresh returned no access token" };
  }
  // Persist the rotated token + cache the fresh access token (free renewal).
  if (json.RefreshToken && json.RefreshToken !== creds.refreshToken) {
    await persistRefreshToken(tenantId, json.RefreshToken);
  }
  accessTokenCache.set(tenantId, json.AccessToken);

  // Days until the (new) refresh token expires, from its JWT exp.
  let expiresInDays: number | null = null;
  try {
    const rt = json.RefreshToken || creds.refreshToken;
    const payload = JSON.parse(
      Buffer.from(rt.split(".")[1], "base64").toString("utf8"),
    );
    if (payload?.exp) {
      expiresInDays = Math.max(
        0,
        Math.round((payload.exp * 1000 - Date.now()) / 86_400_000),
      );
    }
  } catch {
    /* expiry is informational only */
  }
  return { status: "connected", expiresInDays };
}

/**
 * One-time seed (or re-seed) of the rotating refresh_token for a tenant,
 * encrypted at rest. Called from the authenticated seed endpoint so the raw
 * token never leaves the server logs. Validates the token by doing one refresh
 * before storing, so a bad/expired token fails loudly.
 */
export async function seedRefreshToken(
  tenantId: string,
  refreshToken: string,
): Promise<{ ok: true }> {
  // Validate by exchanging it once; also gives us the rotated token to store.
  const res = await fetch(`${PORTAL_BASE}${REFRESH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ RefreshToken: refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`token validation failed (${res.status}): ${body.slice(0, 160)}`);
  }
  const json = (await res.json()) as {
    AccessToken?: string;
    RefreshToken?: string;
  };
  if (!json.AccessToken) throw new Error("token validation returned no AccessToken");
  const toStore = json.RefreshToken || refreshToken;

  const sb = supabaseAdmin();
  const stored = hasEncryptionKey() ? encrypt(toStore) : toStore;
  const { data: existing } = await sb
    .from("integrations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("provider", "phoenix_portal")
    .maybeSingle();
  if (existing) {
    await sb
      .from("integrations")
      .update({ credentials: { refreshToken: stored }, is_active: true })
      .eq("id", existing.id);
  } else {
    const { error } = await sb.from("integrations").insert({
      tenant_id: tenantId,
      provider: "phoenix_portal",
      credentials: { refreshToken: stored },
      is_active: true,
    });
    if (error) throw new Error(`seed insert failed: ${error.message}`);
  }
  // Prime the access-token cache so the immediate next call is fast.
  accessTokenCache.set(tenantId, json.AccessToken);
  return { ok: true };
}

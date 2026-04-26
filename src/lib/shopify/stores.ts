// Reads Shopify store credentials.
//
// Two storage modes are supported during the env-vars → DB transition:
//
//   1. DB-stored (preferred, multi-tenant safe). Encrypted in the
//      stores table:
//        stores.shopify_domain
//        stores.shopify_token_encrypted        (legacy shpat_ static)
//        stores.shopify_client_id              (Dev Dashboard OAuth)
//        stores.shopify_client_secret_encrypted (Dev Dashboard OAuth)
//
//   2. Env-vars (fallback for any store whose DB columns are NULL):
//        {CODE}_DOMAIN
//        {CODE}_TOKEN  (shpat_... or shpss_...)
//        {CODE}_CLIENT_ID  (only when TOKEN is shpss_...)
//
// Two auth modes are supported per store:
//
//   - Legacy custom-app token (used by NOVA/NURA/KOVA — created pre-Jan
//     2026): static shpat_... handed to the Admin API in
//     X-Shopify-Access-Token.
//   - OAuth client credentials (Shopify deprecated custom apps in Jan 2026
//     — any store created after that uses the Dev Dashboard flow, which
//     issues a Client ID + Client Secret instead). The client exchanges
//     these at request time for an access_token and caches it in-process
//     (see client.ts).
//
// We key auth mode off the token prefix — shpat_ means static, shpss_
// means OAuth.

import { supabaseAdmin } from "@/lib/supabase/admin";
import { decrypt, hasEncryptionKey } from "@/lib/crypto";

export type ShopifyStoreCreds = {
  code: string;
  domain: string;
  /** Set when the store uses a legacy static access token. */
  accessToken?: string;
  /** Set when the store uses OAuth client credentials. */
  clientId?: string;
  clientSecret?: string;
};

type StoreRow = {
  id: string;
  shopify_domain: string | null;
  shopify_token_encrypted: string | null;
  shopify_client_id: string | null;
  shopify_client_secret_encrypted: string | null;
};

async function loadDbStoreRow(
  code: string,
  tenantId: string,
): Promise<StoreRow | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select(
      "id, shopify_domain, shopify_token_encrypted, shopify_client_id, shopify_client_secret_encrypted",
    )
    .eq("tenant_id", tenantId)
    .eq("id", code.toUpperCase())
    .maybeSingle();
  if (error) throw new Error(`loadDbStoreRow: ${error.message}`);
  return (data as StoreRow | null) ?? null;
}

function fromEnv(code: string): ShopifyStoreCreds | null {
  const upper = code.toUpperCase();
  const domain = process.env[`${upper}_DOMAIN`];
  const rawToken = process.env[`${upper}_TOKEN`];
  const clientId = process.env[`${upper}_CLIENT_ID`];

  if (!domain || !rawToken) return null;

  if (rawToken.startsWith("shpat_")) {
    return { code: upper, domain, accessToken: rawToken };
  }
  if (rawToken.startsWith("shpss_") && clientId) {
    return { code: upper, domain, clientId, clientSecret: rawToken };
  }
  return null;
}

function fromDbRow(
  code: string,
  row: StoreRow,
): ShopifyStoreCreds | null {
  const domain = row.shopify_domain;
  if (!domain) return null;

  // Prefer OAuth (Client ID + encrypted secret) when both are present;
  // fall back to a static encrypted access token.
  if (row.shopify_client_id && row.shopify_client_secret_encrypted) {
    if (!hasEncryptionKey()) return null;
    return {
      code: code.toUpperCase(),
      domain,
      clientId: row.shopify_client_id,
      clientSecret: decrypt(row.shopify_client_secret_encrypted),
    };
  }
  if (row.shopify_token_encrypted) {
    if (!hasEncryptionKey()) return null;
    return {
      code: code.toUpperCase(),
      domain,
      accessToken: decrypt(row.shopify_token_encrypted),
    };
  }
  return null;
}

/** Resolve credentials for a store. Reads the DB row first; falls back to
 *  env vars matching {CODE}_DOMAIN/{CODE}_TOKEN. Throws when neither is
 *  configured. tenantId is required so the lookup doesn't accidentally
 *  pick up another tenant's store with the same code. */
export async function getStoreCreds(
  code: string,
  tenantId: string,
): Promise<ShopifyStoreCreds> {
  const upper = code.toUpperCase();
  const row = await loadDbStoreRow(upper, tenantId);
  if (row) {
    const fromDb = fromDbRow(upper, row);
    if (fromDb) return fromDb;
  }
  const fromEnvCreds = fromEnv(upper);
  if (fromEnvCreds) return fromEnvCreds;
  throw new Error(
    `No Shopify credentials configured for store "${upper}" in tenant ` +
      `${tenantId}. Save them on the Settings page or set ${upper}_DOMAIN ` +
      `+ ${upper}_TOKEN in env.`,
  );
}

/** True iff this (tenant, store) has live Shopify credentials. Async
 *  because the DB lookup is — but cheap enough to call from a cron loop.
 *  Used to skip dead stores (e.g. NEEDOH) without exploding the cron. */
export async function hasStoreCreds(
  code: string,
  tenantId: string,
): Promise<boolean> {
  try {
    await getStoreCreds(code, tenantId);
    return true;
  } catch {
    return false;
  }
}

/** Env-only diagnostic: list every store code that has env-var creds. */
export function listConfiguredStores(): string[] {
  const codes = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^([A-Z][A-Z0-9_]*)_DOMAIN$/);
    if (!m) continue;
    const code = m[1];
    if (process.env[`${code}_TOKEN`]) codes.add(code);
  }
  return Array.from(codes).sort();
}

export function describeConfiguredTokens(): Array<{
  code: string;
  tokenPrefix: string;
  tokenLength: number;
  authMode: "static" | "oauth" | "unknown";
  hasClientId: boolean;
}> {
  return listConfiguredStores().map((code) => {
    const tok = process.env[`${code}_TOKEN`] ?? "";
    const prefix = tok.slice(0, 7);
    const mode: "static" | "oauth" | "unknown" = tok.startsWith("shpat_")
      ? "static"
      : tok.startsWith("shpss_")
        ? "oauth"
        : "unknown";
    return {
      code,
      tokenPrefix: prefix,
      tokenLength: tok.length,
      authMode: mode,
      hasClientId: Boolean(process.env[`${code}_CLIENT_ID`]),
    };
  });
}

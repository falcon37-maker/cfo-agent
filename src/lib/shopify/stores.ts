// Reads Shopify store credentials from env.
//
// Two auth modes are supported:
//
//  1. Legacy custom-app token (used by NOVA/NURA/KOVA — created pre-Jan 2026):
//       {CODE}_DOMAIN=...
//       {CODE}_TOKEN=shpat_...
//     We hand the static token to the Admin API in X-Shopify-Access-Token.
//
//  2. OAuth client credentials (Shopify deprecated custom apps in Jan 2026 — any
//     store created after that uses the Dev Dashboard flow, which issues a
//     Client ID + Client Secret instead):
//       {CODE}_DOMAIN=...
//       {CODE}_CLIENT_ID=...
//       {CODE}_TOKEN=shpss_...        ← this is the Client Secret
//     The client exchanges these at request time for an access_token and
//     caches it in-process (see client.ts).
//
// We key off the token prefix — shpat_ means static, shpss_ means OAuth.

export type ShopifyStoreCreds = {
  code: string;
  domain: string;
  /** Set when the store uses a legacy static access token. */
  accessToken?: string;
  /** Set when the store uses OAuth client credentials. */
  clientId?: string;
  clientSecret?: string;
};

export function getStoreCreds(code: string): ShopifyStoreCreds {
  const upper = code.toUpperCase();
  const domain = process.env[`${upper}_DOMAIN`];
  const rawToken = process.env[`${upper}_TOKEN`];
  const clientId = process.env[`${upper}_CLIENT_ID`];

  if (!domain || !rawToken) {
    throw new Error(
      `No Shopify credentials configured for store "${upper}". ` +
        `Set ${upper}_DOMAIN and ${upper}_TOKEN in env.`,
    );
  }

  if (rawToken.startsWith("shpat_")) {
    return { code: upper, domain, accessToken: rawToken };
  }

  if (rawToken.startsWith("shpss_")) {
    if (!clientId) {
      throw new Error(
        `Store "${upper}" has an OAuth client secret (${upper}_TOKEN=shpss_...) ` +
          `but no ${upper}_CLIENT_ID. Add the Client ID from the Shopify Dev ` +
          `Dashboard to Vercel env.`,
      );
    }
    return { code: upper, domain, clientId, clientSecret: rawToken };
  }

  throw new Error(
    `Store "${upper}" token has unexpected prefix "${rawToken.slice(0, 7)}". ` +
      `Expected shpat_ (static token) or shpss_ (OAuth client secret).`,
  );
}

/** True if this store has Shopify API credentials configured. Used by the
 *  cron to skip historical / dead stores (e.g. NEEDOH) whose daily_pnl
 *  rows are managed by one-off CSV imports, not the live Shopify API. */
export function hasStoreCreds(code: string): boolean {
  const upper = code.toUpperCase();
  return Boolean(process.env[`${upper}_DOMAIN`] && process.env[`${upper}_TOKEN`]);
}

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

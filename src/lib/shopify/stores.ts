// Reads Shopify store credentials. Tonight: env-var only (`<CODE>_DOMAIN` /
// `<CODE>_TOKEN`). After migration 008 adds `shopify_token` to the stores
// table, `getStoreCreds()` will prefer DB-stored creds and fall back to
// env, so admin-added stores work without a redeploy.

export type ShopifyStoreCreds = {
  code: string;
  domain: string; // e.g. "nova-store.myshopify.com"
  token: string; // Admin API access token — shpat_... or shpss_...
};

export function getStoreCreds(code: string): ShopifyStoreCreds {
  const upper = code.toUpperCase();
  const domain = process.env[`${upper}_DOMAIN`];
  const token = process.env[`${upper}_TOKEN`];
  if (!domain || !token) {
    throw new Error(
      `No Shopify credentials configured for store "${upper}". ` +
        `Set ${upper}_DOMAIN and ${upper}_TOKEN in .env.local.`,
    );
  }
  return { code: upper, domain, token };
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

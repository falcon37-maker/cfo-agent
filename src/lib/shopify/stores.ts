// Reads Shopify store credentials from env. One store per <CODE>_DOMAIN / <CODE>_TOKEN pair.
// `code` is the short uppercase id (e.g. "NOVA") — matches stores.id in the DB.

export type ShopifyStoreCreds = {
  code: string;
  domain: string; // e.g. "nova-store.myshopify.com"
  token: string; // Admin API access token, shpat_...
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

// Shopify Admin API (GraphQL) client, one instance per store.
//
// Handles both legacy static tokens (shpat_) and the post-Jan-2026 OAuth
// client-credentials flow. For OAuth stores we exchange client_id + client_secret
// at the shop's token endpoint and cache the resulting access_token in-process.

import { ShopifyStoreCreds } from "./stores";

const DEFAULT_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

type AccessTokenCacheEntry = { token: string; expiresAt: number };
const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

/** Resolve a bearer access_token for a given store's creds. Uses the static
 *  token if present; otherwise runs the OAuth client_credentials exchange and
 *  caches the result. */
async function resolveAccessToken(creds: ShopifyStoreCreds): Promise<string> {
  if (creds.accessToken) return creds.accessToken;

  if (!creds.clientId || !creds.clientSecret) {
    throw new Error(
      `Store "${creds.code}" has no static access token and is missing ` +
        `OAuth client_id / client_secret.`,
    );
  }

  const cached = accessTokenCache.get(creds.code);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const res = await fetch(
    `https://${creds.domain}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Shopify OAuth token exchange ${res.status} for ${creds.code}: ` +
        body.slice(0, 400),
    );
  }

  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error(
      `Shopify OAuth token exchange for ${creds.code} returned no access_token`,
    );
  }

  const ttlSec = body.expires_in ? Math.max(60, body.expires_in - 60) : 50 * 60;
  accessTokenCache.set(creds.code, {
    token: body.access_token,
    expiresAt: Date.now() + ttlSec * 1000,
  });
  return body.access_token;
}

export class ShopifyClient {
  readonly code: string;
  readonly domain: string;
  private readonly creds: ShopifyStoreCreds;
  private readonly endpoint: string;

  constructor(creds: ShopifyStoreCreds, version: string = DEFAULT_VERSION) {
    this.code = creds.code;
    this.domain = creds.domain;
    this.creds = creds;
    this.endpoint = `https://${creds.domain}/admin/api/${version}/graphql.json`;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await resolveAccessToken(this.creds);
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 1;
        await sleep(retryAfter * 1000 * (attempt + 1));
        lastError = new Error(`Shopify ${res.status} (attempt ${attempt + 1})`);
        continue;
      }

      // If we hit 401 with an OAuth-exchanged token, the cache may have gone
      // stale (rotation, revoke) — bust and retry once.
      if (res.status === 401 && this.creds.clientId) {
        accessTokenCache.delete(this.code);
        if (attempt === 0) {
          lastError = new Error("Shopify 401 — invalidating cached OAuth token");
          continue;
        }
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Shopify ${res.status}: ${body.slice(0, 500)}`);
      }

      const json = (await res.json()) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };
      if (json.errors?.length) {
        throw new Error(
          `Shopify GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
        );
      }
      if (!json.data) throw new Error("Shopify response missing `data`");
      return json.data;
    }
    throw lastError ?? new Error("Shopify request failed after 3 attempts");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

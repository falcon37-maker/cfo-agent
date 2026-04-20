// Minimal Shopify Admin API (GraphQL) client.
// One instance per store. Uses the 2025-01 API version by default.

import { ShopifyStoreCreds } from "./stores";

const DEFAULT_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

export class ShopifyClient {
  readonly code: string;
  readonly domain: string;
  private readonly token: string;
  private readonly endpoint: string;

  constructor(creds: ShopifyStoreCreds, version: string = DEFAULT_VERSION) {
    this.code = creds.code;
    this.domain = creds.domain;
    this.token = creds.token;
    this.endpoint = `https://${creds.domain}/admin/api/${version}/graphql.json`;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    // Up to 3 retries on 429 / 5xx with Shopify's Retry-After honored.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.token,
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

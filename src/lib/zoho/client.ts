// Zoho Books API client. Thin wrapper around fetch() that injects the auth
// header + organization_id, and retries once on 401 (stale cache or backend
// rotated the token before our expiry window kicked in).

import {
  getAccessToken,
  loadCredentials,
  refreshAccessToken,
  zohoEnv,
} from "./tokens";

const API_BASE = "https://www.zohoapis.com/books/v3";

export type ZohoFetchOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

export async function zohoFetch<T>(
  path: string,
  opts: ZohoFetchOptions = {},
): Promise<T> {
  const { ORG_ID } = zohoEnv();
  if (!ORG_ID) throw new Error("ZOHO_ORG_ID not set");

  const url = buildUrl(path, { ...opts.query, organization_id: ORG_ID });
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (opts.body != null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  // First attempt: use the cached (or freshly-refreshed) access token.
  let accessToken = await getAccessToken();
  let res = await fetch(url, {
    ...init,
    headers: { ...headers, Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  // Zoho sometimes returns 401 if the token was invalidated server-side
  // before our TTL ran out. One retry after a refresh.
  if (res.status === 401) {
    const creds = await loadCredentials();
    if (creds) {
      accessToken = await refreshAccessToken(creds.refresh_token);
      res = await fetch(url, {
        ...init,
        headers: { ...headers, Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Zoho ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as T;
}

function buildUrl(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const url = new URL(path.startsWith("/") ? `${API_BASE}${path}` : path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

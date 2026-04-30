// Solvpath (Phoenix CRM) API client.
//
// Every request needs FOUR headers:
//   - partnerId        (per-tenant integrations row, env var fallback)
//   - partnerToken     (per-tenant integrations row, env var fallback)
//   - request-id       (fresh UUID per request)
//   - Authorization    (Bearer per-tenant or env fallback)
//
// Multi-tenant (phase 3): credentials are resolved per tenant via
// getSolvpathCreds(tenantId) — DB-stored values win over env vars when
// populated. Joseph's existing env-vars keep working until his
// integrations row gets populated via Settings → Integrations.

import { getSolvpathCreds } from "@/lib/integrations";

async function authForTenant(
  tenantId: string,
): Promise<{ headers: Record<string, string>; baseUrl: string }> {
  const creds = await getSolvpathCreds(tenantId);
  if (!creds) {
    throw new Error(
      `Solvpath credentials not configured for tenant ${tenantId}. ` +
        `Save them in Settings → Integrations or set SOLVPATH_PARTNER_ID / ` +
        `SOLVPATH_PARTNER_TOKEN / SOLVPATH_BEARER_TOKEN in env.`,
    );
  }
  return {
    headers: {
      partnerId: creds.partnerId,
      partnerToken: creds.partnerToken,
      "request-id": crypto.randomUUID(),
      Authorization: `Bearer ${creds.bearerToken}`,
      Accept: "application/json",
    },
    baseUrl: creds.baseUrl.replace(/\/+$/, ""),
  };
}

// Fewer retries keep each failing call short so we don't burn the Vercel
// function's 60s budget on 1/2/4/8s backoff. Persistent rate-limit issues
// surface up to the backfill loop which waits longer between chunks.
const MAX_RETRIES = 2;

async function solvpathRequest<T>(
  tenantId: string,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | undefined | null>,
  body?: unknown,
): Promise<T> {
  const auth = await authForTenant(tenantId);
  const url = new URL(auth.baseUrl + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  let lastText = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Fresh request-id per attempt; partner/bearer creds stay constant.
    const headers: Record<string, string> = {
      ...auth.headers,
      "request-id": crypto.randomUUID(),
    };
    const init: RequestInit = { method, headers, cache: "no-store" };
    if (body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), init);
    if (res.ok) return (await res.json()) as T;

    lastStatus = res.status;
    lastText = await res.text().catch(() => "");

    // Back off and retry on rate-limit + transient 5xx.
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    break; // non-retryable
  }
  throw new Error(
    `Solvpath ${lastStatus} ${method} ${path}: ${lastText.slice(0, 400)}`,
  );
}

async function solvpathGet<T>(
  tenantId: string,
  path: string,
  params?: Record<string, string | number | undefined | null>,
): Promise<T> {
  return solvpathRequest<T>(tenantId, "GET", path, params);
}

// ─── Types (from docs) ──────────────────────────────────────────────────────
export type SolvpathListResponse<T> = {
  Result: T[];
  TotalCount: number;
  Page: number;
  Limit: number;
};

export type SolvpathStore = {
  Title: string;
  DomainUrl: string;
  ShopifyId: string;
  StoreCode: number;
  IsDeleted: boolean;
  Type: string;
};

export type SolvpathCustomer = {
  CustomerId: number;
  Email: string;
  FirstName: string;
  LastName: string;
  SubscriptionStatus: string; // "Active" | "Cancelled" | "Paused" | ...
  EnrollmentDate: string;
  NextBillingDate: string;
  OriginalTransactionDate: string;
  CancelledSubscriptionDate: string;
  SuccessOrderId: number;
};

export type SolvpathTransaction = {
  Date: string; // ISO
  Amount: string;
  Domain: string;
  StoreCode?: number; // Solvpath store id; matches /stores response
  OrderId: number;
  VipOrder: number;
  TransactionType: string; // "Direct Sale No Vault", "Void", "Refund", etc
  Type: string; // "Direct", "Recurring", "Salvage", ...
  RecurringOrderCount: number;
  ResponseCode: string; // "100" = success
  ResponseMessage: string;
  ShopifyOrderNumber: string;
  MerchTxnRef: number;
};

// ─── Endpoint wrappers ──────────────────────────────────────────────────────
export async function listStores(
  tenantId: string,
  params: { Page?: number; Limit?: number } = {},
): Promise<SolvpathListResponse<SolvpathStore>> {
  return solvpathGet(tenantId, "/stores", {
    Limit: params.Limit ?? 100,
    Page: params.Page ?? 1,
  });
}

export async function listCustomers(
  tenantId: string,
  params: {
    Page?: number;
    Limit?: number;
    SubscriptionStatus?: string;
  },
): Promise<SolvpathListResponse<SolvpathCustomer>> {
  return solvpathGet(tenantId, "/customers", {
    Limit: params.Limit ?? 250,
    Page: params.Page ?? 1,
    SubscriptionStatus: params.SubscriptionStatus,
  });
}

export async function getTransactionHistory(
  tenantId: string,
  customerId: number,
  startDateTime?: string,
): Promise<{ Result: SolvpathTransaction[] }> {
  return solvpathGet(tenantId, "/transaction-history", {
    CustomerId: customerId,
    StartDateTime: startDateTime,
  });
}

/**
 * Iterate every page of /customers with the given filter and yield one
 * customer at a time. Safer than eagerly materializing 10k+ records.
 */
export async function* iterateCustomers(
  tenantId: string,
  subscriptionStatus?: string,
  pageSize = 250,
): AsyncGenerator<SolvpathCustomer> {
  let page = 1;
  while (true) {
    const resp = await listCustomers(tenantId, {
      Page: page,
      Limit: pageSize,
      SubscriptionStatus: subscriptionStatus,
    });
    for (const c of resp.Result ?? []) yield c;
    const fetched = page * pageSize;
    if (fetched >= resp.TotalCount || !resp.Result?.length) break;
    page += 1;
  }
}

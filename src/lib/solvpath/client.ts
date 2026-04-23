// Solvpath (Phoenix CRM) API client.
//
// Every request needs FOUR headers:
//   - partnerId        (SOLVPATH_PARTNER_ID)
//   - partnerToken     (SOLVPATH_PARTNER_TOKEN)
//   - request-id       (fresh UUID per request)
//   - Authorization    (Bearer SOLVPATH_BEARER_TOKEN)

const DEFAULT_BASE = "https://pffe.phoenixtechnologies.io/phxcrm";

function baseUrl(): string {
  return (process.env.SOLVPATH_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function authHeaders(): Record<string, string> {
  return {
    partnerId: requireEnv("SOLVPATH_PARTNER_ID"),
    partnerToken: requireEnv("SOLVPATH_PARTNER_TOKEN"),
    "request-id": crypto.randomUUID(),
    Authorization: `Bearer ${requireEnv("SOLVPATH_BEARER_TOKEN")}`,
    Accept: "application/json",
  };
}

// Fewer retries keep each failing call short so we don't burn the Vercel
// function's 60s budget on 1/2/4/8s backoff. Persistent rate-limit issues
// surface up to the backfill loop which waits longer between chunks.
const MAX_RETRIES = 2;

async function solvpathRequest<T>(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | undefined | null>,
  body?: unknown,
): Promise<T> {
  const url = new URL(baseUrl() + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  let lastText = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Fresh headers each attempt so request-id is unique per retry.
    const headers = authHeaders();
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
  path: string,
  params?: Record<string, string | number | undefined | null>,
): Promise<T> {
  return solvpathRequest<T>("GET", path, params);
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
  params: { Page?: number; Limit?: number } = {},
): Promise<SolvpathListResponse<SolvpathStore>> {
  return solvpathGet("/stores", {
    Limit: params.Limit ?? 100,
    Page: params.Page ?? 1,
  });
}

export async function listCustomers(params: {
  Page?: number;
  Limit?: number;
  SubscriptionStatus?: string;
}): Promise<SolvpathListResponse<SolvpathCustomer>> {
  return solvpathGet("/customers", {
    Limit: params.Limit ?? 250,
    Page: params.Page ?? 1,
    SubscriptionStatus: params.SubscriptionStatus,
  });
}

export async function getTransactionHistory(
  customerId: number,
  startDateTime?: string,
): Promise<{ Result: SolvpathTransaction[] }> {
  return solvpathGet("/transaction-history", {
    CustomerId: customerId,
    StartDateTime: startDateTime,
  });
}

/**
 * Iterate every page of /customers with the given filter and yield one
 * customer at a time. Safer than eagerly materializing 10k+ records.
 */
export async function* iterateCustomers(
  subscriptionStatus?: string,
  pageSize = 250,
): AsyncGenerator<SolvpathCustomer> {
  let page = 1;
  while (true) {
    const resp = await listCustomers({
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

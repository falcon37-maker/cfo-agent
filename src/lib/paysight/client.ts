// Paysight API client.
//
// Paysight is a subscription/payment CRM (same family as Phoenix/Solvpath).
// Per the client, we pull Paysight data into the CFO Agent dashboard
// alongside Phoenix for a combined subscription view.
//
// Auth (from docs.paysight.io/api-reference/introduction):
//   - Authorization: <api-key>     ← RAW key, NOT "Bearer <key>"
//   - ClientId:      <tenant/parent-company id, e.g. 505>
//   - UserEmail:     <requesting user's email>
//
// Endpoints we use (mitigation API — works for bulk pulls):
//   POST /api/mitigation/subscriptions   (active + inactive subs, max 1 day/window)
//   POST /api/mitigation/transactions    (transactions, max 7 day/window)
//
// Rate limits: 100 req/min global; 40 req/min for broad transaction searches.

import { getPaysightCreds, type PaysightCreds } from "@/lib/integrations";

const DEFAULT_LIMIT = 1000; // API max per page

// ─── Response types (from the OpenAPI spec) ───────────────────────────

export type PaysightSubscription = {
  parentCompanyId: number;
  companyId: number;
  mid: string;
  descriptor: string;
  id: number; // internal subscription id
  customerId: number;
  subDate: string; // ISO date-time
  unsubDate: string | null;
  orderId: number;
  active: boolean;
  unsubscribeOrderId: number;
  email: string;
  subId: number; // subscription plan id
  frozen: boolean;
};

export type PaysightTransaction = {
  gateway: string;
  transactionId: string; // UUID
  orderId: number;
  sent: string; // ISO date-time
  email: string;
  sandbox: boolean;
  applicationId: number; // 200=Refund 201=Chargeback 202=CB Alert
  status: string;
  statusId: number;
  success: boolean;
  completed: string; // ISO date-time
  currency: string;
  amount: number;
  mid: string;
  descriptor: string;
  customerId: number;
  authCode: string;
  gatewayTransactionId: string;
  firstName: string;
  lastName: string;
  bin: string;
  last4: string;
  refunded: boolean;
  refundable: boolean;
  hasAlert: boolean;
  chargedBack: boolean;
  originalTransactionId: string | null;
};

type SubscriptionResponse = {
  success: boolean;
  message: string;
  count: number;
  pageNumber: number;
  moreResults: boolean;
  subscriptions: PaysightSubscription[];
};

type TransactionResponse = {
  success: boolean;
  message: string;
  count: number;
  pageNumber: number;
  moreResults: boolean;
  transactions: PaysightTransaction[];
};

// ─── HTTP plumbing ────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function paysightPost<T>(
  tenantId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const creds = await getPaysightCreds(tenantId);
  if (!creds) {
    throw new Error(
      `Paysight credentials not configured for tenant ${tenantId}. ` +
        `Save them in Settings → Integrations or set PAYSIGHT_API_KEY / ` +
        `PAYSIGHT_CLIENT_ID / PAYSIGHT_USER_EMAIL in env.`,
    );
  }

  const url = creds.baseUrl.replace(/\/+$/, "") + path;
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Raw API key in Authorization (NOT Bearer). Confirmed via live test.
        Authorization: creds.apiKey,
        ClientId: creds.clientId,
        UserEmail: creds.userEmail,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    if (res.ok) return (await res.json()) as T;

    lastStatus = res.status;
    lastText = await res.text().catch(() => "");

    // Retry on rate-limit + transient 5xx with backoff.
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break; // non-retryable
  }
  throw new Error(
    `Paysight ${lastStatus} POST ${path}: ${lastText.slice(0, 400)}`,
  );
}

// ─── Endpoint wrappers ────────────────────────────────────────────────

/**
 * Fetch one page of subscriptions for a date window.
 * NOTE: the API caps broad (date-only) searches at 1 day — dateFrom must
 * equal dateTo. For email/orderId filtered searches the window can be wider.
 */
export async function searchSubscriptions(
  tenantId: string,
  params: {
    pageNumber: number;
    limit?: number;
    dateFrom?: string; // YYYY-MM-DD
    dateTo?: string; // YYYY-MM-DD
    emails?: string[];
    orderIds?: number[];
  },
): Promise<SubscriptionResponse> {
  return paysightPost<SubscriptionResponse>(
    tenantId,
    "/api/mitigation/subscriptions",
    {
      pageNumber: params.pageNumber,
      limit: params.limit ?? DEFAULT_LIMIT,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      emails: params.emails,
      orderIds: params.orderIds,
    },
  );
}

/**
 * Fetch one page of transactions for a date window.
 * Broad (date-only) searches are capped at 7 days (dateFrom..dateTo) and
 * rate-limited to 40 req/min.
 */
export async function searchTransactions(
  tenantId: string,
  params: {
    pageNumber: number;
    limit?: number;
    dateFrom?: string;
    dateTo?: string;
    emails?: string[];
    orderIds?: number[];
    includeUpdated?: boolean;
  },
): Promise<TransactionResponse> {
  return paysightPost<TransactionResponse>(
    tenantId,
    "/api/mitigation/transactions",
    {
      pageNumber: params.pageNumber,
      limit: params.limit ?? DEFAULT_LIMIT,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      emails: params.emails,
      orderIds: params.orderIds,
      includeUpdated: params.includeUpdated,
    },
  );
}

/** Iterate every page of subscriptions for a single day. */
export async function* iterateSubscriptions(
  tenantId: string,
  date: string, // YYYY-MM-DD (dateFrom === dateTo for broad search)
  pageSize = DEFAULT_LIMIT,
): AsyncGenerator<PaysightSubscription> {
  let page = 1;
  while (true) {
    const resp = await searchSubscriptions(tenantId, {
      pageNumber: page,
      limit: pageSize,
      dateFrom: date,
      dateTo: date,
    });
    for (const s of resp.subscriptions ?? []) yield s;
    if (!resp.moreResults || !resp.subscriptions?.length) break;
    page += 1;
  }
}

/** Iterate every page of transactions for a date window (≤ 7 days). */
export async function* iterateTransactions(
  tenantId: string,
  dateFrom: string,
  dateTo: string,
  pageSize = DEFAULT_LIMIT,
): AsyncGenerator<PaysightTransaction> {
  let page = 1;
  while (true) {
    const resp = await searchTransactions(tenantId, {
      pageNumber: page,
      limit: pageSize,
      dateFrom,
      dateTo,
    });
    for (const t of resp.transactions ?? []) yield t;
    if (!resp.moreResults || !resp.transactions?.length) break;
    page += 1;
  }
}

export type { PaysightCreds };

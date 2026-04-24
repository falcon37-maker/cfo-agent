// Chargeblast API client.
// https://api.chargeblast.com/api/v2 — auth is a simple `api_key` query param.
// Webhook handling (svix signatures) lives separately in the webhook route.
//
// The raw API uses camelCase field names (createdAt, alertType, descriptor,
// cardBrand…) and returns ~10 alerts per page regardless of what `per_page`
// we ask for. The iterator below normalizes to snake_case + our canonical
// fields, and drives pagination off the response's own `per` field.

const BASE = "https://api.chargeblast.com/api/v2";

type RawAlert = {
  id: string;
  alertId?: string;
  descriptor?: string | null;
  cardBrand?: string | null;
  alertType?: string | null;
  provider?: string | null; // "ethoca" | "verifi" | ...
  subprovider?: string | null; // "Ethoca" | "RDR" | "CDRN"
  amount?: number | null;
  currency?: string | null;
  acquirerAction?: string | null; // "Resolved" | ...
  responseAction?: string | null; // "Accepted" | "RequiresResponse" | ...
  creditStatus?: string | null; // "None" | "Approved" | "Declined" | ...
  isRefunded?: boolean | null;
  reasonCode?: string | null;
  createdAt?: string | null;
  invoicedAt?: string | null;
  transactionDate?: string | null;
  merchantName?: string | null;
  site?: string | null;
  // Optional fields that only appear on some provider types.
  orderId?: string | null;
  customerEmail?: string | null;
};

type RawList = {
  alerts: RawAlert[];
  total: number;
  page: number;
  per?: number; // actual page size
  per_page?: number;
};

export type ChargeblastAlert = {
  id: string;
  merchant_descriptor: string | null;
  card_brand: string | null;
  alert_type: string | null;
  amount: number;
  currency: string;
  status: "pending" | "won" | "lost" | "refunded" | "unknown";
  created_at: string | null;
  updated_at: string | null;
  order_id: string | null;
  customer_email: string | null;
  reason: string | null;
};

export type AlertFilters = {
  start_date?: string;
  end_date?: string;
  status?: string;
  page?: number;
  per_page?: number;
};

function requireKey(): string {
  const k = process.env.CHARGEBLAST_API_KEY;
  if (!k) throw new Error("CHARGEBLAST_API_KEY not set");
  return k;
}

/**
 * Collapse the various Chargeblast state fields into our four-value status.
 * Lossy — raw fields are preserved in the DB row so we can refine later.
 */
function deriveStatus(a: RawAlert): ChargeblastAlert["status"] {
  if (a.isRefunded) return "refunded";
  const credit = (a.creditStatus ?? "").toLowerCase();
  if (credit === "approved") return "won";
  if (credit === "declined" || credit === "rejected") return "lost";

  const acq = (a.acquirerAction ?? "").toLowerCase();
  if (acq === "resolved") return "won";
  if (acq === "accepted" || acq === "won") return "won";
  if (acq === "lost" || acq === "rejected") return "lost";

  const resp = (a.responseAction ?? "").toLowerCase();
  if (resp === "accepted") return "won";
  if (resp === "requiresresponse" || resp === "pending") return "pending";

  return "unknown";
}

function normalize(a: RawAlert): ChargeblastAlert {
  return {
    id: a.id ?? a.alertId ?? "",
    merchant_descriptor: a.descriptor ?? null,
    card_brand: a.cardBrand ?? null,
    alert_type: a.alertType ?? a.subprovider ?? a.provider ?? null,
    amount: Number(a.amount ?? 0),
    currency: a.currency || "USD",
    status: deriveStatus(a),
    created_at: a.createdAt ?? null,
    updated_at: a.invoicedAt ?? null,
    order_id: a.orderId ?? null,
    customer_email: a.customerEmail ?? null,
    reason: a.reasonCode ?? null,
  };
}

async function cbFetch<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", requireKey());
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chargeblast ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function listAlertsPage(filters: AlertFilters = {}): Promise<{
  alerts: ChargeblastAlert[];
  total: number;
  page: number;
  per: number;
}> {
  const raw = await cbFetch<RawList>("/alerts", {
    start_date: filters.start_date,
    end_date: filters.end_date,
    status: filters.status,
    page: filters.page ?? 1,
    per_page: filters.per_page,
  });
  return {
    alerts: (raw.alerts ?? []).map(normalize),
    total: raw.total ?? 0,
    page: raw.page ?? 1,
    per: raw.per ?? raw.per_page ?? (raw.alerts?.length ?? 10),
  };
}

/** Iterate every page of /alerts within the given filters. Driven by the
 *  API's actual per-page size rather than our request. */
export async function* iterateAlerts(
  filters: AlertFilters = {},
): AsyncGenerator<ChargeblastAlert> {
  let page = 1;
  while (true) {
    const resp = await listAlertsPage({ ...filters, page });
    for (const a of resp.alerts) yield a;
    const perPage = resp.per || resp.alerts.length;
    if (!perPage) break;
    const fetched = page * perPage;
    if (resp.alerts.length === 0) break;
    if (fetched >= resp.total) break;
    page += 1;
  }
}

/** Sanity-check the credential. */
export async function ping(): Promise<{
  ok: true;
  total: number;
  sample: ChargeblastAlert | null;
}> {
  const r = await listAlertsPage({});
  return { ok: true, total: r.total, sample: r.alerts[0] ?? null };
}

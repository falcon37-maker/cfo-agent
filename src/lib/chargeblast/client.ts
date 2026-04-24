// Chargeblast API client.
// https://api.chargeblast.com/api/v2 — auth is a simple `api_key` query param.
// Webhook handling (svix signatures) lives separately in the webhook route.

const BASE = "https://api.chargeblast.com/api/v2";

export type ChargeblastAlert = {
  id: string;
  merchant_descriptor: string;
  card_brand: string; // "visa" | "mastercard"
  alert_type: string; // "ethoca" | "cdrn" | "rdr"
  amount: number;
  currency: string;
  status: string; // "pending" | "won" | "lost" | "refunded"
  created_at: string;
  updated_at: string;
  order_id: string;
  customer_email: string;
  reason: string;
};

type ListResponse = {
  alerts: ChargeblastAlert[];
  total: number;
  page: number;
  per_page: number;
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

export async function listAlerts(filters: AlertFilters = {}): Promise<ListResponse> {
  return cbFetch<ListResponse>("/alerts", {
    start_date: filters.start_date,
    end_date: filters.end_date,
    status: filters.status,
    page: filters.page ?? 1,
    per_page: filters.per_page ?? 100,
  });
}

/** Iterate every page of /alerts within the given filters. */
export async function* iterateAlerts(
  filters: AlertFilters = {},
): AsyncGenerator<ChargeblastAlert> {
  let page = 1;
  const perPage = filters.per_page ?? 100;
  while (true) {
    const resp = await listAlerts({ ...filters, page, per_page: perPage });
    for (const a of resp.alerts ?? []) yield a;
    if (!resp.alerts?.length || page * perPage >= resp.total) break;
    page += 1;
  }
}

/** Sanity-check the credential. Returns the first alert if any exist,
 *  or null. Used by the Settings "Test Connection" button. */
export async function ping(): Promise<{
  ok: true;
  total: number;
  sample: ChargeblastAlert | null;
}> {
  const r = await listAlerts({ per_page: 1 });
  return { ok: true, total: r.total, sample: r.alerts?.[0] ?? null };
}

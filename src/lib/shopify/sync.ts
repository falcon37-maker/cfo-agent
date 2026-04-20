// Pulls orders for a given date (in the store's timezone) from Shopify
// and upserts the daily aggregate into Supabase `daily_orders`.

import { ShopifyClient } from "./client";
import { getStoreCreds } from "./stores";
import { supabaseAdmin } from "@/lib/supabase/admin";

type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  currentSubtotalPriceSet: { shopMoney: { amount: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  totalShippingPriceSet: { shopMoney: { amount: string } };
  totalTaxSet: { shopMoney: { amount: string } };
  totalRefundedSet: { shopMoney: { amount: string } };
  subtotalLineItemsQuantity: number;
};

type OrdersPage = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyOrder[];
  };
};

const ORDERS_QUERY = /* GraphQL */ `
  query DailyOrders($query: String!, $cursor: String) {
    orders(first: 100, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        subtotalLineItemsQuantity
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentSubtotalPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }
`;

export type DailyPullResult = {
  storeCode: string;
  date: string; // YYYY-MM-DD
  orderCount: number;
  unitCount: number;
  grossSales: number;
  discounts: number;
  refunds: number;
  shipping: number;
  tax: number;
  netRevenue: number;
  currency: string;
};

/**
 * Pull + aggregate + upsert orders for one store on one date.
 * `date` is YYYY-MM-DD and is interpreted in the store's timezone (from DB).
 * If no store row exists yet, defaults to UTC.
 */
export async function syncDailyOrders(
  storeCode: string,
  date: string,
): Promise<DailyPullResult> {
  const creds = getStoreCreds(storeCode);
  const sb = supabaseAdmin();

  const { data: storeRow } = await sb
    .from("stores")
    .select("id, timezone, currency")
    .eq("id", creds.code)
    .maybeSingle();

  const tz = storeRow?.timezone ?? "UTC";

  // Shopify `query:` accepts created_at:>=... with ISO timestamps.
  // Build the [start, end) window for `date` in the store's tz.
  const { startIso, endIso } = dayWindowInTz(date, tz);

  const client = new ShopifyClient(creds);

  let cursor: string | null = null;
  let orderCount = 0;
  let unitCount = 0;
  let grossSales = 0;
  let discounts = 0;
  let refunds = 0;
  let shipping = 0;
  let tax = 0;
  let currency = storeRow?.currency ?? "USD";

  // Paginate through all orders in the window.
  do {
    const data: OrdersPage = await client.graphql<OrdersPage>(ORDERS_QUERY, {
      query: `created_at:>=${startIso} created_at:<${endIso}`,
      cursor,
    });

    for (const o of data.orders.nodes) {
      orderCount += 1;
      unitCount += o.subtotalLineItemsQuantity ?? 0;
      grossSales += num(o.currentSubtotalPriceSet.shopMoney.amount);
      discounts += num(o.totalDiscountsSet.shopMoney.amount);
      shipping += num(o.totalShippingPriceSet.shopMoney.amount);
      tax += num(o.totalTaxSet.shopMoney.amount);
      refunds += num(o.totalRefundedSet.shopMoney.amount);
      currency = o.currentTotalPriceSet.shopMoney.currencyCode || currency;
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  const netRevenue = round2(grossSales - discounts - refunds);

  const row = {
    store_id: creds.code,
    date,
    order_count: orderCount,
    unit_count: unitCount,
    gross_sales: round2(grossSales),
    discounts: round2(discounts),
    refunds: round2(refunds),
    shipping: round2(shipping),
    tax: round2(tax),
    net_revenue: netRevenue,
    currency,
    synced_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from("daily_orders")
    .upsert(row, { onConflict: "store_id,date" });
  if (error) throw new Error(`daily_orders upsert failed: ${error.message}`);

  return {
    storeCode: creds.code,
    date,
    orderCount,
    unitCount,
    grossSales: row.gross_sales,
    discounts: row.discounts,
    refunds: row.refunds,
    shipping: row.shipping,
    tax: row.tax,
    netRevenue,
    currency,
  };
}

function num(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Returns the ISO timestamps [start, end) for the given YYYY-MM-DD in tz.
 * Uses Intl to derive tz offset at the target instant (handles DST).
 */
function dayWindowInTz(date: string, tz: string): { startIso: string; endIso: string } {
  const [y, m, d] = date.split("-").map(Number);
  const start = zonedDateToUtc(y, m, d, 0, tz);
  const end = zonedDateToUtc(y, m, d + 1, 0, tz);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// Convert a wall-clock date/time in tz to the corresponding UTC instant.
function zonedDateToUtc(y: number, m: number, d: number, h: number, tz: string): Date {
  // Start with a guess at UTC, then correct by the tz offset at that instant.
  const guess = new Date(Date.UTC(y, m - 1, d, h));
  const offsetMs = tzOffsetMs(guess, tz);
  return new Date(guess.getTime() - offsetMs);
}

function tzOffsetMs(at: Date, tz: string): number {
  // What wall-clock time does `at` (UTC) appear as in `tz`?
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

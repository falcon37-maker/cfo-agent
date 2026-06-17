// Pulls orders for a given date (in the store's timezone) from Shopify
// and upserts the daily aggregate into Supabase `daily_orders`.

import { ShopifyClient } from "./client";
import { getStoreCreds } from "./stores";
import { supabaseAdmin } from "@/lib/supabase/admin";

type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  // Original (non-"current") prices: what the order was placed at, BEFORE
  // post-checkout refunds. Matches what Shopify's Sales Report uses as
  // "Net sales" baseline (subtotalPriceSet = gross − discounts).
  subtotalPriceSet: { shopMoney: { amount: string } };
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  totalShippingPriceSet: { shopMoney: { amount: string } };
  totalTaxSet: { shopMoney: { amount: string } };
  totalRefundedSet: { shopMoney: { amount: string } };
  subtotalLineItemsQuantity: number;
  // Extra fields for per-order detail storage (powers the expand panel
  // without a live GraphQL call).
  tags: string[];
  sourceName: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: { displayName: string | null; email: string | null } | null;
  channelInformation: {
    displayName: string | null;
    channelDefinition: { channelName: string | null } | null;
  } | null;
};

type OrdersPage = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyOrder[];
  };
};

// Orders query, parameterized over whether the app has the `read_customers`
// scope. Stores connected via a custom OAuth app that lacks `read_customers`
// (e.g. the drop-ship stores SOLEN/VOLEN/ELARA) get ACCESS_DENIED on the
// `customer` field, which fails the ENTIRE query and silently dropped their
// sync. Customer name/email is order-detail nice-to-have, not needed for the
// P&L numbers, so we omit it when the scope is missing and still sync revenue.
function buildOrdersQuery(includeCustomer: boolean): string {
  const customerField = includeCustomer
    ? "customer { displayName email }"
    : "";
  return /* GraphQL */ `
  query DailyOrders($query: String!, $cursor: String) {
    orders(first: 100, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        cancelledAt
        subtotalLineItemsQuantity
        tags
        sourceName
        displayFinancialStatus
        displayFulfillmentStatus
        ${customerField}
        channelInformation {
          displayName
          channelDefinition { channelName }
        }
        totalPriceSet           { shopMoney { amount currencyCode } }
        subtotalPriceSet        { shopMoney { amount } }
        totalDiscountsSet       { shopMoney { amount } }
        totalShippingPriceSet   { shopMoney { amount } }
        totalTaxSet             { shopMoney { amount } }
        totalRefundedSet        { shopMoney { amount } }
      }
    }
  }
`;
}

const ORDERS_QUERY = buildOrdersQuery(true);
const ORDERS_QUERY_NO_CUSTOMER = buildOrdersQuery(false);

/** True when a GraphQL error is Shopify's missing-scope error for a field. */
function isAccessScopeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ACCESS_DENIED|access scope|read_customers/i.test(msg);
}

function channelLabelFor(o: ShopifyOrder): string {
  const ch = o.channelInformation?.displayName?.trim();
  if (ch) return ch;
  const src = (o.sourceName || "").toLowerCase();
  if (!src || src === "web") return "Online Store";
  if (src === "shop") return "Shop";
  if (src === "pos") return "Point of Sale";
  if (src === "mobile") return "Mobile";
  if (/^\d+$/.test(src)) return "Online Store";
  return src.charAt(0).toUpperCase() + src.slice(1);
}

// Fetch the shop's IANA timezone. We use this to align our day-windows
// with what Shopify Admin displays. Storing a wrong timezone (e.g. NY
// when the store is actually Chicago) causes orders to land on adjacent
// days vs. what Shopify shows — visible as +/- orders per day even though
// the monthly total matches.
const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      ianaTimezone
      currencyCode
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
  tenantId: string,
): Promise<DailyPullResult> {
  const creds = await getStoreCreds(storeCode, tenantId);
  const sb = supabaseAdmin();

  const { data: storeRow } = await sb
    .from("stores")
    .select("id, timezone, currency")
    .eq("tenant_id", tenantId)
    .eq("id", creds.code)
    .maybeSingle();

  const client = new ShopifyClient(creds);

  // Fetch the SHOP's actual IANA timezone from Shopify on every sync, and
  // keep our DB copy in lockstep. Without this, our day windows can drift
  // from what Shopify Admin shows when the DB timezone is wrong (we
  // observed SOLEN stored as America/New_York while the actual store
  // runs in America/Chicago — a 1-hour window shift was assigning some
  // orders to the wrong day).
  let tz = storeRow?.timezone ?? "UTC";
  try {
    const shopInfo = await client.graphql<{
      shop: { ianaTimezone: string; currencyCode: string };
    }>(SHOP_INFO_QUERY, {});
    const realTz = shopInfo?.shop?.ianaTimezone;
    if (realTz && realTz !== tz) {
      tz = realTz;
      // Persist so future computations / dashboard displays are aligned.
      await sb
        .from("stores")
        .update({ timezone: realTz })
        .eq("tenant_id", tenantId)
        .eq("id", creds.code);
    }
  } catch {
    // Non-fatal — fall back to stored tz (or UTC) if shop query fails.
  }

  // Shopify `query:` accepts created_at:>=... with ISO timestamps.
  // Build the [start, end) window for `date` in the store's tz.
  const { startIso, endIso } = dayWindowInTz(date, tz);

  let cursor: string | null = null;
  let orderCount = 0;
  let unitCount = 0;
  // `gross_sales` field in daily_orders is the figure we surface on the
  // dashboard as "revenue". Per client (May 2026 meeting): this should
  // match Shopify Admin → Analytics → Sales Report's "Net sales" column,
  // which is defined as gross − discounts − returns.
  //
  // subtotalPriceSet is the order subtotal AFTER discounts but BEFORE
  // returns/refunds. So:
  //   our gross_sales = Σ subtotalPriceSet     (= Shopify Net sales pre-refunds)
  //   our net_revenue = gross_sales − refunds  (= Shopify Net sales)
  //
  // We do NOT subtract discounts again here — they were already removed
  // by Shopify before we read subtotalPriceSet. That was the SOLEN bug
  // (gross was after-discounts but we still subtracted discounts again,
  // pushing net negative).
  let grossSales = 0;
  let discounts = 0;
  let refunds = 0;
  let shipping = 0;
  let tax = 0;
  let currency = storeRow?.currency ?? "USD";

  // Whether to request the `customer` field. Starts true; if Shopify returns
  // an access-scope error (app lacks read_customers), we drop the field for
  // this store and retry the same page — so revenue still syncs.
  let includeCustomer = true;

  // Defense-in-depth: dedupe by order id. Shopify's cursor is usually
  // stable but order modifications mid-pagination can occasionally return
  // the same order twice. Cheap to skip the second occurrence.
  const seenIds = new Set<string>();

  // Per-order rows collected for the shopify_orders table. We upsert
  // them in one batch after pagination completes so the SQL round-trips
  // don't bloat the sync time linearly with order count.
  const orderRows: Array<Record<string, unknown>> = [];

  // Paginate through all orders in the window.
  do {
    // Shopify search syntax uses ':' as field-value separator. ISO
    // timestamps contain colons too — unless we wrap the value in single
    // quotes, the parser treats the embedded ':' as additional field
    // refs and silently drops one side of the range. Symptom: counts
    // explode (e.g. 48 → 101 for KOVA May 31) because only the lower
    // bound survives, leaving a half-infinite window.
    const vars = {
      query: `created_at:>='${startIso}' created_at:<'${endIso}'`,
      cursor,
    };
    let data: OrdersPage;
    try {
      data = await client.graphql<OrdersPage>(
        includeCustomer ? ORDERS_QUERY : ORDERS_QUERY_NO_CUSTOMER,
        vars,
      );
    } catch (err) {
      // App lacks read_customers — drop the customer field and retry the
      // SAME page so this store's revenue still syncs (name/email stay null).
      if (includeCustomer && isAccessScopeError(err)) {
        includeCustomer = false;
        data = await client.graphql<OrdersPage>(
          ORDERS_QUERY_NO_CUSTOMER,
          vars,
        );
      } else {
        throw err;
      }
    }

    for (const o of data.orders.nodes) {
      // Skip cancelled orders — Shopify's Sales Report excludes them too.
      if (o.cancelledAt) continue;
      if (seenIds.has(o.id)) continue;
      seenIds.add(o.id);

      orderCount += 1;
      unitCount += o.subtotalLineItemsQuantity ?? 0;
      const subAmount = num(o.subtotalPriceSet.shopMoney.amount);
      const discAmount = num(o.totalDiscountsSet.shopMoney.amount);
      const shipAmount = num(o.totalShippingPriceSet.shopMoney.amount);
      const taxAmount = num(o.totalTaxSet.shopMoney.amount);
      const refAmount = num(o.totalRefundedSet.shopMoney.amount);
      const totalAmount = num(o.totalPriceSet.shopMoney.amount);

      grossSales += subAmount;
      discounts += discAmount;
      shipping += shipAmount;
      tax += taxAmount;
      refunds += refAmount;
      currency = o.totalPriceSet.shopMoney.currencyCode || currency;

      orderRows.push({
        tenant_id: tenantId,
        store_id: creds.code,
        shopify_order_id: o.id,
        name: o.name,
        created_at_shopify: o.createdAt,
        cancelled_at: o.cancelledAt,
        store_local_date: date,
        customer_name: o.customer?.displayName ?? null,
        customer_email: o.customer?.email ?? null,
        channel: channelLabelFor(o),
        source_name: o.sourceName ?? null,
        items: o.subtotalLineItemsQuantity ?? 0,
        tags: Array.isArray(o.tags) ? o.tags : [],
        financial_status: o.displayFinancialStatus ?? null,
        fulfillment_status: o.displayFulfillmentStatus ?? null,
        subtotal: round2(subAmount),
        discounts: round2(discAmount),
        shipping: round2(shipAmount),
        tax: round2(taxAmount),
        refunded: round2(refAmount),
        total: round2(totalAmount),
        currency: o.totalPriceSet.shopMoney.currencyCode || currency,
      });
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  const netRevenue = round2(grossSales - refunds);

  const row = {
    tenant_id: tenantId,
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

  // Replace per-order rows for this (tenant, store, date). Delete-then-
  // insert keeps the table consistent with Shopify if an order was
  // cancelled / dropped between syncs — a pure upsert would leave the
  // old row sitting there. Done in chunks of 500 for the Supabase
  // payload size limits.
  await sb
    .from("shopify_orders")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("store_id", creds.code)
    .eq("store_local_date", date);

  if (orderRows.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < orderRows.length; i += CHUNK) {
      const slice = orderRows.slice(i, i + CHUNK);
      const { error: oerr } = await sb.from("shopify_orders").insert(slice);
      if (oerr) {
        throw new Error(`shopify_orders insert failed: ${oerr.message}`);
      }
    }
  }

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

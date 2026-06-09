// GET /api/pnl/day-orders?date=YYYY-MM-DD&store=NOVA
//
// Returns the list of individual orders for a given store-day.
//
// SOURCE OF TRUTH: our own `shopify_orders` table — populated by the
// daily sync. We used to fetch this live from Shopify GraphQL on every
// expand click, which (a) hit rate limits and (b) hit the colon-in-ISO
// query bug that returned half-infinite windows. Reading from our DB is
// instant, consistent with `daily_orders`, and offline-safe.
//
// `store=` accepts: a single store id, a comma list, or "ALL"/"" for
// every store the tenant has set up.
//
// Auth: standard tenant session (cookie).

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORE_RE = /^[A-Z0-9_]{1,32}$/;
const STORE_LIST_RE = /^([A-Z0-9_]{1,32})(,[A-Z0-9_]{1,32})*$/;

export async function GET(req: NextRequest) {
  let tenant;
  try {
    tenant = await requireTenant();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const date = sp.get("date") ?? "";
  const storeRaw = (sp.get("store") ?? "").toUpperCase();
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "invalid date" }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // Resolve which stores to fetch.
  let storeIds: string[];
  if (!storeRaw || storeRaw === "ALL") {
    const { data: storesData } = await sb
      .from("stores")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true);
    storeIds = (storesData ?? [])
      .map((s) => s.id as string)
      .filter((id) => id !== "PORTFOLIO" && id !== "__BACKFILL_DEDUPE__");
  } else if (STORE_LIST_RE.test(storeRaw)) {
    storeIds = storeRaw.split(",").map((s) => s.trim());
  } else if (STORE_RE.test(storeRaw)) {
    storeIds = [storeRaw];
  } else {
    return NextResponse.json({ error: "invalid store" }, { status: 400 });
  }

  // Pull per-order rows from our DB. Newest-first to mirror Shopify Admin.
  const { data: rows, error } = await sb
    .from("shopify_orders")
    .select(
      "store_id, shopify_order_id, name, created_at_shopify, customer_name, customer_email, channel, items, tags, financial_status, fulfillment_status, subtotal, discounts, shipping, tax, refunded, total, currency",
    )
    .eq("tenant_id", tenant.id)
    .in("store_id", storeIds)
    .eq("store_local_date", date)
    .order("created_at_shopify", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `query failed: ${error.message}` },
      { status: 500 },
    );
  }

  // Per-store metadata. We also include the timezone (for any frontend
  // affordance that wants it) and report stores that have zero rows for
  // this date as "no orders" rather than an error — pure "store has no
  // creds" is a different signal and rare here since we filter by what
  // tenant_id can see.
  const { data: storeRows } = await sb
    .from("stores")
    .select("id, timezone")
    .eq("tenant_id", tenant.id)
    .in("id", storeIds);

  const tzByStore: Record<string, string> = {};
  for (const s of storeRows ?? []) {
    tzByStore[s.id as string] = (s.timezone as string) ?? "UTC";
  }

  const countByStore: Record<string, number> = {};
  for (const r of rows ?? []) {
    countByStore[r.store_id as string] =
      (countByStore[r.store_id as string] ?? 0) + 1;
  }

  const perStoreMeta = storeIds.map((id) => ({
    store: id,
    timezone: tzByStore[id] ?? "UTC",
    orderCount: countByStore[id] ?? 0,
  }));

  const orders = (rows ?? []).map((r) => ({
    store: r.store_id,
    id: r.shopify_order_id,
    name: r.name,
    createdAt: r.created_at_shopify,
    customer: r.customer_name || r.customer_email || "Guest",
    channel: r.channel ?? "Online Store",
    items: r.items ?? 0,
    tags: Array.isArray(r.tags) ? r.tags : [],
    financialStatus: r.financial_status ?? "",
    fulfillmentStatus: r.fulfillment_status ?? "",
    subtotal: Number(r.subtotal),
    discounts: Number(r.discounts),
    shipping: Number(r.shipping),
    tax: Number(r.tax),
    refunded: Number(r.refunded),
    total: Number(r.total),
    currency: r.currency ?? "USD",
  }));

  const totals = orders.reduce(
    (acc, o) => {
      acc.subtotal += o.subtotal;
      acc.discounts += o.discounts;
      acc.shipping += o.shipping;
      acc.tax += o.tax;
      acc.refunded += o.refunded;
      acc.total += o.total;
      return acc;
    },
    { subtotal: 0, discounts: 0, shipping: 0, tax: 0, refunded: 0, total: 0 },
  );

  return NextResponse.json({
    date,
    stores: storeIds,
    perStoreMeta,
    orderCount: orders.length,
    totals,
    orders,
  });
}

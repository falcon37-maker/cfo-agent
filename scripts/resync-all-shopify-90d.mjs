// One-shot backfill: re-fetch the last 90 days of orders from Shopify for
// every active store and rewrite both `daily_orders` (aggregate) and
// `shopify_orders` (per-order rows). Required after the colon-quoting bug
// fix (see memory: feedback-shopify-query-quoting) because every existing
// daily_orders row was over-counted.
//
// Standalone — does not import sync.ts (which is TypeScript and not
// runnable directly from node). The logic here mirrors sync.ts and the
// per-order insert added in migration 018.
//
// Usage:  node --env-file=.env scripts/resync-all-shopify-90d.mjs
//
// Safe to re-run: each (store, date) wipes its shopify_orders rows
// before re-inserting; daily_orders is upserted on (store_id, date).

import { createClient } from "@supabase/supabase-js";

const DAYS = 90;
const API_VERSION = "2025-01";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ─── 1. Find every (tenant, store) with Shopify creds in the DB ───────
// Reads tokens from the encrypted `shopify_token_encrypted` column (post
// env→DB migration). Env-var fallback is no longer used at runtime — see
// scripts/migrate-env-creds-to-db.mjs for the one-shot migration.
import { createDecipheriv } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadEncryptionKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error("CREDENTIAL_ENCRYPTION_KEY not set in env");
  let k;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) k = Buffer.from(raw, "hex");
  else k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error(`key must decode to 32 bytes (got ${k.length})`);
  return k;
}
const ENC_KEY = loadEncryptionKey();

function decryptToken(envelope) {
  const buf = Buffer.from(envelope, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const d = createDecipheriv(ALGO, ENC_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

const { data: storeRows, error: storesErr } = await sb
  .from("stores")
  .select(
    "id, tenant_id, timezone, currency, is_active, shopify_domain, " +
      "shopify_token_encrypted, shopify_client_id, shopify_client_secret_encrypted",
  )
  .eq("is_active", true);
if (storesErr) {
  console.error("stores query failed:", storesErr.message);
  process.exit(1);
}

// OAuth client_credentials token cache. Each store's exchanged access_token
// is held for ~50 min so we don't re-exchange for every paginated request.
const oauthCache = new Map();

async function resolveBearerToken(target) {
  if (target.staticToken) return target.staticToken;
  if (!target.clientId || !target.clientSecret) {
    throw new Error(`${target.storeId}: no static token AND no OAuth pair`);
  }
  const cached = oauthCache.get(target.storeId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const r = await fetch(`https://${target.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: target.clientId,
      client_secret: target.clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) {
    throw new Error(
      `OAuth token exchange ${r.status} for ${target.storeId}: ${(await r.text()).slice(0, 200)}`,
    );
  }
  const body = await r.json();
  if (!body.access_token) {
    throw new Error(`${target.storeId}: OAuth response missing access_token`);
  }
  const ttlSec = body.expires_in ? Math.max(60, body.expires_in - 60) : 50 * 60;
  oauthCache.set(target.storeId, {
    token: body.access_token,
    expiresAt: Date.now() + ttlSec * 1000,
  });
  return body.access_token;
}

const targets = [];
for (const s of storeRows ?? []) {
  if (s.id === "PORTFOLIO" || s.id === "__BACKFILL_DEDUPE__") continue;
  if (!s.shopify_domain) {
    console.log(`  skip ${s.id} — no shopify_domain on stores row`);
    continue;
  }

  let staticToken = null;
  let clientId = null;
  let clientSecret = null;
  let authMode = null;

  if (s.shopify_token_encrypted) {
    try {
      staticToken = decryptToken(s.shopify_token_encrypted);
      authMode = "static";
    } catch (e) {
      console.log(`  skip ${s.id} — static token decrypt failed: ${e.message}`);
      continue;
    }
  } else if (s.shopify_client_id && s.shopify_client_secret_encrypted) {
    try {
      clientId = s.shopify_client_id;
      clientSecret = decryptToken(s.shopify_client_secret_encrypted);
      authMode = "oauth";
    } catch (e) {
      console.log(`  skip ${s.id} — OAuth secret decrypt failed: ${e.message}`);
      continue;
    }
  } else {
    console.log(`  skip ${s.id} — no credentials in DB (neither token nor OAuth pair)`);
    continue;
  }

  targets.push({
    storeId: s.id,
    tenantId: s.tenant_id,
    timezone: s.timezone || "UTC",
    currency: s.currency || "USD",
    domain: s.shopify_domain,
    authMode,
    staticToken,
    clientId,
    clientSecret,
  });
}

console.log(`\n═══ Resync: ${targets.length} stores × ${DAYS} days ═══`);
for (const t of targets) console.log(`  ${t.storeId.padEnd(8)} tz=${t.timezone}`);
console.log("");

// ─── 2. Helpers ──────────────────────────────────────────────────────
// Unified call signature: takes a `target` and resolves the bearer
// (static or OAuth-exchanged) just-in-time. Handles 401-on-OAuth by
// busting the access-token cache and retrying once.
async function gql(target, query, variables) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await resolveBearerToken(target);
    const r = await fetch(
      `https://${target.domain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (r.status === 401 && target.authMode === "oauth" && attempt === 0) {
      oauthCache.delete(target.storeId);
      continue;
    }
    const j = await r.json();
    if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors)}`);
    return j.data;
  }
  throw new Error(`${target.storeId}: gql failed after retry`);
}

const SHOP_INFO = `{ shop { ianaTimezone currencyCode } }`;

// Full query (requires `read_customers` scope). Static-token apps get
// this scope by default when we create the custom app; OAuth apps need
// it granted in the Partner Dashboard.
const ORDERS_Q_FULL = `
  query DailyOrders($query: String!, $cursor: String) {
    orders(first: 100, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt subtotalLineItemsQuantity
        tags sourceName displayFinancialStatus displayFulfillmentStatus
        customer { displayName email }
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

// Fallback query without `customer` — used when read_customers isn't
// granted (most OAuth apps installed without that scope). Loses
// customer name/email; everything else (revenue, tags, payment status,
// channel) still syncs.
const ORDERS_Q_NO_CUSTOMER = `
  query DailyOrders($query: String!, $cursor: String) {
    orders(first: 100, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt subtotalLineItemsQuantity
        tags sourceName displayFinancialStatus displayFulfillmentStatus
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

function num(s) { const n = Number(s); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round(n * 100) / 100; }

function tzOffsetMs(at, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute), Number(parts.second),
  );
  return asUtc - at.getTime();
}
function zonedDateToUtc(y, m, d, h, tz) {
  const guess = new Date(Date.UTC(y, m - 1, d, h));
  return new Date(guess.getTime() - tzOffsetMs(guess, tz));
}
function dayWindowInTz(date, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const start = zonedDateToUtc(y, m, d, 0, tz);
  const end = zonedDateToUtc(y, m, d + 1, 0, tz);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
function ymdInTz(date, tz) {
  return date.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

function channelLabelFor(o) {
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

// ─── 3. Resync one (store, date) ────────────────────────────────────
async function syncDay(target, date) {
  // Refresh tz from Shopify once per day-loop (cheap, ensures we never
  // window with a stale tz). Skip if already done for this store.
  let tz = target._realTz ?? target.timezone;
  if (!target._realTz) {
    try {
      const data = await gql(target, SHOP_INFO, {});
      const realTz = data?.shop?.ianaTimezone;
      if (realTz) {
        if (realTz !== target.timezone) {
          await sb.from("stores").update({ timezone: realTz })
            .eq("tenant_id", target.tenantId).eq("id", target.storeId);
          console.log(`  ${target.storeId}: tz corrected ${target.timezone} → ${realTz}`);
        }
        tz = realTz;
        target._realTz = realTz;
      }
    } catch (e) {
      console.log(`  ${target.storeId}: shop-info failed: ${e.message} (using stored tz)`);
    }
  }

  const { startIso, endIso } = dayWindowInTz(date, tz);

  let cursor = null;
  let orderCount = 0, unitCount = 0;
  let grossSales = 0, discounts = 0, refunds = 0, shipping = 0, tax = 0;
  let currency = target.currency;
  const seen = new Set();
  const orderRows = [];

  do {
    // Pick query based on which scopes this store's app actually has.
    // After the first ACCESS_DENIED for `customer`, we sticky-downgrade
    // the target for the rest of its 60-day window so we don't keep
    // retrying the full query.
    const queryStr = target._noCustomer ? ORDERS_Q_NO_CUSTOMER : ORDERS_Q_FULL;
    let data;
    try {
      data = await gql(target, queryStr, {
        // QUOTED — see colon-parsing bug.
        query: `created_at:>='${startIso}' created_at:<'${endIso}'`,
        cursor,
      });
    } catch (e) {
      // If the failure is specifically the read_customers ACCESS_DENIED,
      // drop the customer field and retry once. Stays downgraded for
      // future iterations on the same target.
      if (!target._noCustomer && /read_customers|ACCESS_DENIED/.test(e.message)) {
        target._noCustomer = true;
        console.log(`  ${target.storeId}: app lacks read_customers — downgrading query (customer name/email won't be stored)`);
        data = await gql(target, ORDERS_Q_NO_CUSTOMER, {
          query: `created_at:>='${startIso}' created_at:<'${endIso}'`,
          cursor,
        });
      } else {
        throw e;
      }
    }
    for (const o of data.orders.nodes) {
      if (o.cancelledAt) continue;
      if (seen.has(o.id)) continue;
      seen.add(o.id);

      orderCount += 1;
      unitCount += o.subtotalLineItemsQuantity ?? 0;
      const sub = num(o.subtotalPriceSet.shopMoney.amount);
      const disc = num(o.totalDiscountsSet.shopMoney.amount);
      const ship = num(o.totalShippingPriceSet.shopMoney.amount);
      const tx = num(o.totalTaxSet.shopMoney.amount);
      const ref = num(o.totalRefundedSet.shopMoney.amount);
      const tot = num(o.totalPriceSet.shopMoney.amount);
      grossSales += sub; discounts += disc; shipping += ship; tax += tx; refunds += ref;
      currency = o.totalPriceSet.shopMoney.currencyCode || currency;

      orderRows.push({
        tenant_id: target.tenantId,
        store_id: target.storeId,
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
        subtotal: round2(sub),
        discounts: round2(disc),
        shipping: round2(ship),
        tax: round2(tx),
        refunded: round2(ref),
        total: round2(tot),
        currency,
      });
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  // Upsert daily_orders aggregate.
  const aggRow = {
    tenant_id: target.tenantId,
    store_id: target.storeId,
    date,
    order_count: orderCount,
    unit_count: unitCount,
    gross_sales: round2(grossSales),
    discounts: round2(discounts),
    refunds: round2(refunds),
    shipping: round2(shipping),
    tax: round2(tax),
    net_revenue: round2(grossSales - refunds),
    currency,
    synced_at: new Date().toISOString(),
  };
  const { error: aggErr } = await sb.from("daily_orders")
    .upsert(aggRow, { onConflict: "store_id,date" });
  if (aggErr) throw new Error(`daily_orders upsert: ${aggErr.message}`);

  // Replace per-order rows for this (store, date).
  await sb.from("shopify_orders").delete()
    .eq("tenant_id", target.tenantId)
    .eq("store_id", target.storeId)
    .eq("store_local_date", date);
  if (orderRows.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < orderRows.length; i += CHUNK) {
      const { error: oErr } = await sb.from("shopify_orders")
        .insert(orderRows.slice(i, i + CHUNK));
      if (oErr) throw new Error(`shopify_orders insert: ${oErr.message}`);
    }
  }

  return { orderCount, grossSales: round2(grossSales) };
}

// ─── 4. Build date list (last N days, store-local TODAY back N) ──────
// We compute the date list per-store inside the loop so each store
// uses its own tz to determine "today".

const startedAll = Date.now();
const summary = [];

for (const target of targets) {
  console.log(`\n── ${target.storeId} ──`);
  const tStart = Date.now();
  // Determine date list in store-local tz so the boundary days line up.
  // We can't refresh tz until shop-info runs inside syncDay; use stored tz
  // for date enumeration (good enough — the actual window math inside
  // syncDay still uses the refreshed tz).
  const tzForList = target.timezone || "UTC";
  const dates = [];
  const today = ymdInTz(new Date(), tzForList);
  const [ty, tm, td] = today.split("-").map(Number);
  for (let i = 0; i < DAYS; i++) {
    const dt = new Date(Date.UTC(ty, tm - 1, td - i));
    dates.push(dt.toISOString().slice(0, 10));
  }

  let totalOrders = 0;
  let totalGross = 0;
  let failed = 0;
  for (const d of dates) {
    try {
      const r = await syncDay(target, d);
      totalOrders += r.orderCount;
      totalGross += r.grossSales;
      process.stdout.write(`    ${d}: ${String(r.orderCount).padStart(4)} orders · $${r.grossSales.toFixed(2).padStart(10)}\n`);
    } catch (e) {
      failed++;
      console.log(`    ${d}: ✗ ${e.message}`);
    }
  }
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`  ${target.storeId} done — ${DAYS} days, ${totalOrders} orders, $${totalGross.toFixed(2)}, ${failed} failed, ${elapsed}s`);
  summary.push({
    store: target.storeId, days: DAYS, orders: totalOrders,
    gross: round2(totalGross), failed, elapsedSec: Number(elapsed),
  });
}

const totalElapsed = ((Date.now() - startedAll) / 1000).toFixed(1);
console.log(`\n═══ Done in ${totalElapsed}s ═══`);
console.table(summary);

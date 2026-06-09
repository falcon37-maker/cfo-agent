// Shopify reconciliation script.
//
// Pulls a store's orders fresh from Shopify for a given date (in store's
// timezone) and shows EVERY relevant total side-by-side with what we have
// stored in `daily_orders`. The goal is to expose exactly which figure the
// dashboard mismatches the Shopify admin UI's Sales Report on, so we can
// align the dashboard to the source of truth.
//
// Usage:
//   node --env-file=.env scripts/reconcile-shopify.mjs <STORE_ID> <DATE>
//   node --env-file=.env scripts/reconcile-shopify.mjs ELARA 2026-05-25
//   node --env-file=.env scripts/reconcile-shopify.mjs ELARA 2026-05-25 --tz=America/New_York
//
// Outputs:
//   - Order count, line-item qty
//   - Currency
//   - Per-figure breakdown (gross, discounts, shipping, tax, refunds)
//   - 3 different "revenue" figures that Shopify reports use:
//       * Gross sales         = product price × qty (BEFORE discounts)
//       * Net sales           = gross − discounts − returns (Shopify Sales Report uses this)
//       * Total sales         = net sales + tax + shipping
//   - What `daily_orders` currently stores
//   - The exact gap, broken down line-by-line
//
// Read-only. Never writes to the DB.

import { Client as PgClient } from "pg";
import { createDecipheriv } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")),
);
const positional = args.filter((a) => !a.startsWith("--"));
const [STORE_ID, DATE] = positional;
if (!STORE_ID || !DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(
    "Usage: node --env-file=.env scripts/reconcile-shopify.mjs <STORE_ID> <YYYY-MM-DD> [--tz=TZ]",
  );
  process.exit(1);
}
const STORE = STORE_ID.toUpperCase();

const db = new PgClient({ connectionString: DB_URL });
await db.connect();

// ── Get store credentials + timezone ────────────────────────────────────
// Mirrors src/lib/shopify/stores.ts: pull the encrypted static token OR
// the encrypted OAuth client_secret from the stores row, decrypt with
// CREDENTIAL_ENCRYPTION_KEY, and resolve a bearer token. Env-var fallback
// was removed in the Jun 2026 env→DB migration.
const storeRes = await db.query(
  `SELECT id, tenant_id, timezone, shopify_domain,
          shopify_token_encrypted,
          shopify_client_id, shopify_client_secret_encrypted
     FROM stores
     WHERE id = $1
     LIMIT 1`,
  [STORE],
);
if (storeRes.rows.length === 0) {
  console.error(`Store ${STORE} not found.`);
  process.exit(1);
}
const {
  tenant_id, timezone,
  shopify_domain,
  shopify_token_encrypted,
  shopify_client_id,
  shopify_client_secret_encrypted,
} = storeRes.rows[0];
const TZ = flags.tz || timezone || "UTC";
const shop_domain = shopify_domain;
if (!shop_domain) {
  console.error(`Store ${STORE} has no shopify_domain in DB.`);
  process.exit(1);
}

let token = null;
if (shopify_token_encrypted) {
  try {
    token = decryptEnvelope(shopify_token_encrypted);
  } catch (e) {
    console.error(`Could not decrypt DB static token for ${STORE}: ${e.message}`);
    process.exit(1);
  }
} else if (shopify_client_id && shopify_client_secret_encrypted) {
  // OAuth — exchange client_id + secret for a short-lived access_token.
  let secret;
  try {
    secret = decryptEnvelope(shopify_client_secret_encrypted);
  } catch (e) {
    console.error(`Could not decrypt DB OAuth secret for ${STORE}: ${e.message}`);
    process.exit(1);
  }
  const r = await fetch(`https://${shop_domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: shopify_client_id,
      client_secret: secret,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) {
    console.error(`OAuth exchange failed for ${STORE}: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const body = await r.json();
  if (!body.access_token) {
    console.error(`OAuth exchange returned no access_token for ${STORE}`);
    process.exit(1);
  }
  token = body.access_token;
}
if (!token) {
  console.error(
    `${STORE} has no credentials in DB. Open Settings → Stores → Edit ${STORE} and paste a token.`,
  );
  process.exit(1);
}
if (!shop_domain) {
  console.error(
    `No Shopify domain for ${STORE}. Expected env var: ${STORE}_DOMAIN.`,
  );
  process.exit(1);
}

function decryptEnvelope(envelopeBase64) {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error("CREDENTIAL_ENCRYPTION_KEY not set");
  let key;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("key must decode to 32 bytes");
  const buf = Buffer.from(envelopeBase64, "base64");
  if (buf.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

console.log(`\n═══ Shopify Reconciliation — ${STORE} on ${DATE} ═══`);
console.log(`   Timezone: ${TZ}`);
console.log(`   Shop:     ${shop_domain}\n`);

// ── Compute the day window in the store's timezone ──────────────────────
function dayWindowInTz(date, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const offsetMs = tzOffsetMs(guess, tz);
  const start = new Date(guess.getTime() - offsetMs);
  const endGuess = new Date(Date.UTC(y, m - 1, d + 1));
  const endOffsetMs = tzOffsetMs(endGuess, tz);
  const end = new Date(endGuess.getTime() - endOffsetMs);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
function tzOffsetMs(at, tz) {
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
  );
  const asLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? 0 : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asLocal - at.getTime();
}

const { startIso, endIso } = dayWindowInTz(DATE, TZ);
console.log(`   Window:   ${startIso}  →  ${endIso}`);
console.log(
  `             (${DATE} 00:00:00 in ${TZ} to ${DATE} 24:00:00 in ${TZ})\n`,
);

// ── Pull orders from Shopify GraphQL ────────────────────────────────────
const ORDERS_QUERY = `
  query DailyOrders($query: String!, $cursor: String) {
    orders(first: 100, query: $query, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        cancelledAt
        subtotalLineItemsQuantity
        currentTotalPriceSet      { shopMoney { amount currencyCode } }
        subtotalPriceSet          { shopMoney { amount } }
        currentSubtotalPriceSet   { shopMoney { amount } }
        totalDiscountsSet         { shopMoney { amount } }
        totalShippingPriceSet     { shopMoney { amount } }
        totalTaxSet               { shopMoney { amount } }
        totalRefundedSet          { shopMoney { amount } }
      }
    }
  }
`;

async function shopifyGraphql(query, variables) {
  const r = await fetch(`https://${shop_domain}/admin/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (json.errors) {
    console.error("Shopify GraphQL errors:", JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data;
}

let cursor = null;
let orderCount = 0;
let cancelledCount = 0;
let unitCount = 0;
let currentTotal = 0;          // currentTotalPriceSet (after refunds + tax + shipping)
let currentSubtotal = 0;       // currentSubtotalPriceSet (after refunds, after discounts)
let subtotalPre = 0;           // subtotalPriceSet (PRE-refund, after discounts) — our stored gross_sales
let discounts = 0;
let shipping = 0;
let tax = 0;
let refunds = 0;
const sampleOrders = [];

do {
  const data = await shopifyGraphql(ORDERS_QUERY, {
    query: `created_at:>=${startIso} created_at:<${endIso}`,
    cursor,
  });
  for (const o of data.orders.nodes) {
    orderCount += 1;
    if (o.cancelledAt) {
      cancelledCount += 1;
      continue; // Our sync skips cancelled orders; reconcile script does too
    }
    unitCount += o.subtotalLineItemsQuantity ?? 0;
    currentTotal += Number(o.currentTotalPriceSet.shopMoney.amount);
    currentSubtotal += Number(o.currentSubtotalPriceSet.shopMoney.amount);
    subtotalPre += Number(o.subtotalPriceSet.shopMoney.amount);
    discounts += Number(o.totalDiscountsSet.shopMoney.amount);
    shipping += Number(o.totalShippingPriceSet.shopMoney.amount);
    tax += Number(o.totalTaxSet.shopMoney.amount);
    refunds += Number(o.totalRefundedSet.shopMoney.amount);
    if (sampleOrders.length < 5) {
      sampleOrders.push({
        name: o.name,
        createdAt: o.createdAt,
        cancelled: !!o.cancelledAt,
        subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
        total: Number(o.currentTotalPriceSet.shopMoney.amount),
        discount: Number(o.totalDiscountsSet.shopMoney.amount),
        ship: Number(o.totalShippingPriceSet.shopMoney.amount),
        tax: Number(o.totalTaxSet.shopMoney.amount),
        refunded: Number(o.totalRefundedSet.shopMoney.amount),
      });
    }
  }
  cursor = data.orders.pageInfo.hasNextPage
    ? data.orders.pageInfo.endCursor
    : null;
} while (cursor);

const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) =>
  `$${r2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Derive Shopify's standard revenue figures ──────────────────────────
// Shopify Admin → Analytics → Sales Report definitions:
//   Gross sales = product price × qty (BEFORE discounts)
//   Net sales   = Gross − discounts − returns
//   Total sales = Net + tax + shipping
//
// In Shopify's GraphQL:
//   subtotalPriceSet         = Gross − discounts  (PRE-refund)
//   currentSubtotalPriceSet  = Gross − discounts  (POST-refund, after returns)
//   totalRefundedSet         = returns
const grossSalesApprox = subtotalPre + discounts;  // re-add discounts to get the true "gross"
const netSales = subtotalPre - refunds;             // = Shopify's "Net sales" on the Sales Report
const totalSales = netSales + tax + shipping;

// ── Read what we have stored ────────────────────────────────────────────
const storedRes = await db.query(
  `SELECT order_count, unit_count, gross_sales, discounts, refunds,
          shipping, tax, net_revenue, currency, synced_at
     FROM daily_orders
     WHERE tenant_id = $1 AND store_id = $2 AND date = $3
     LIMIT 1`,
  [tenant_id, STORE, DATE],
);
const stored = storedRes.rows[0];

// ── Report ──────────────────────────────────────────────────────────────
console.log("── Live Shopify ─────────────────────────────────────");
console.log(`  Orders in window:       ${orderCount}  (cancelled+skipped: ${cancelledCount})`);
console.log(`  Line-item qty:          ${unitCount}`);
console.log(`  subtotalPriceSet Σ:     ${fmt(subtotalPre)}    ← what we now store as gross_sales`);
console.log(`  currentSubtotalSet Σ:   ${fmt(currentSubtotal)}    (post-refund)`);
console.log(`  Current total Σ:        ${fmt(currentTotal)}`);
console.log(`  Discounts Σ:            ${fmt(discounts)}`);
console.log(`  Shipping Σ:             ${fmt(shipping)}`);
console.log(`  Tax Σ:                  ${fmt(tax)}`);
console.log(`  Refunds Σ:              ${fmt(refunds)}`);
console.log("");
console.log("  Shopify Sales Report formulas:");
console.log(`    Gross sales (approx):  ${fmt(grossSalesApprox)}   = subtotal + discounts`);
console.log(`    Net sales:             ${fmt(netSales)}            = gross − discounts − returns`);
console.log(`    Total sales:           ${fmt(totalSales)}          = net + tax + shipping`);

console.log("\n── What we stored ──────────────────────────────────");
if (!stored) {
  console.log("  (no daily_orders row for this store-date)");
} else {
  console.log(`  order_count:            ${stored.order_count}`);
  console.log(`  unit_count:             ${stored.unit_count}`);
  console.log(`  gross_sales:            ${fmt(Number(stored.gross_sales))}`);
  console.log(`  discounts:              ${fmt(Number(stored.discounts))}`);
  console.log(`  refunds:                ${fmt(Number(stored.refunds))}`);
  console.log(`  shipping:               ${fmt(Number(stored.shipping))}`);
  console.log(`  tax:                    ${fmt(Number(stored.tax))}`);
  console.log(`  net_revenue:            ${fmt(Number(stored.net_revenue))}`);
  console.log(`  synced_at:              ${stored.synced_at}`);
}

console.log("\n── Gap analysis ────────────────────────────────────");
if (stored) {
  const orderGap = orderCount - Number(stored.order_count);
  const grossGap = currentSubtotal - Number(stored.gross_sales);
  console.log(
    `  Order count gap:        ${orderGap >= 0 ? "+" : ""}${orderGap}  (live − stored)`,
  );
  console.log(
    `  gross_sales gap:        ${grossGap >= 0 ? "+" : ""}${fmt(grossGap)}  (live − stored)`,
  );
  if (Math.abs(grossGap) > 0.01) {
    console.log(`    → likely cause: stale sync (resync needed) or post-sync refunds`);
  }
}

console.log("\n── How each Shopify figure compares to stored gross_sales ──");
if (stored) {
  const sg = Number(stored.gross_sales);
  console.log(
    `  Stored gross_sales:    ${fmt(sg)}    (currentSubtotal at sync time)`,
  );
  console.log(
    `  Net sales:             ${fmt(netSales)}    diff vs stored: ${fmt(netSales - sg)}`,
  );
  console.log(
    `  Total sales:           ${fmt(totalSales)}    diff vs stored: ${fmt(totalSales - sg)}`,
  );
  console.log(
    `  Current total:         ${fmt(currentTotal)}    diff vs stored: ${fmt(currentTotal - sg)}`,
  );
}

console.log("\n── Sample orders (first 5) ─────────────────────────");
for (const o of sampleOrders) {
  console.log(
    `  ${o.name.padEnd(8)} ${o.createdAt.slice(0, 19)}  sub=${fmt(o.subtotal).padStart(10)}  total=${fmt(o.total).padStart(10)}  disc=${fmt(o.discount).padStart(8)}  refund=${fmt(o.refunded).padStart(8)}${o.cancelled ? "  CANCELLED" : ""}`,
  );
}

console.log("\n── Recommendation ──────────────────────────────────");
console.log("  Compare these numbers to what client sees in Shopify Admin →");
console.log("  Analytics → Sales Report for the same date. Whichever Shopify");
console.log("  figure matches the client's expectation is the one we should");
console.log("  store in daily_orders.gross_sales going forward.\n");

await db.end();

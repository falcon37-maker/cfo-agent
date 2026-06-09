// @deprecated VOLEN-specific Shopify diagnostic from before the env→DB
// credential migration. Kept for reference. For live debugging, use
// scripts/reconcile-shopify.mjs VOLEN <DATE> which reads credentials
// from the encrypted stores table (supports both static + OAuth auth).
//
// Original purpose: figure out why our sync returned 0 orders despite
// Shopify Admin showing orders. (Resolved — was the colon-quoting bug.)
//
// Legacy usage:
//   VOLEN_DOMAIN=bym030-91.myshopify.com VOLEN_TOKEN=shpat_xxx \
//     node --env-file=.env scripts/diagnose-volen.mjs

const DOMAIN = process.env.VOLEN_DOMAIN;
const TOKEN = process.env.VOLEN_TOKEN;

if (!DOMAIN || !TOKEN) {
  console.error("Set VOLEN_DOMAIN and VOLEN_TOKEN in env or as command-line vars.");
  console.error("Example: VOLEN_DOMAIN=bym030-91.myshopify.com VOLEN_TOKEN=shpat_xxx node scripts/diagnose-volen.mjs");
  process.exit(1);
}

console.log(`\n═══ VOLEN Shopify Diagnostic ═══`);
console.log(`   Domain:  ${DOMAIN}`);
console.log(`   Token:   ${TOKEN.slice(0, 8)}…${TOKEN.slice(-4)}\n`);

async function query(name, gql, variables) {
  console.log(`── ${name} ──`);
  const r = await fetch(`https://${DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query: gql, variables }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.log(`  HTTP ${r.status}: ${text.slice(0, 300)}`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`  Non-JSON response: ${text.slice(0, 300)}`);
    return null;
  }
  if (json.errors) {
    console.log(`  GraphQL errors:`, JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

// 1. Shop info — confirm we're hitting the right store
const shopData = await query(
  "shop info",
  `query { shop { name primaryDomain { url } myshopifyDomain currencyCode } }`,
);
if (shopData?.shop) {
  console.log(`  shop.name              = ${shopData.shop.name}`);
  console.log(`  shop.primaryDomain.url = ${shopData.shop.primaryDomain?.url}`);
  console.log(`  shop.myshopifyDomain   = ${shopData.shop.myshopifyDomain}`);
  console.log(`  shop.currencyCode      = ${shopData.shop.currencyCode}`);
}
console.log("");

// 2. Order count — total
const countData = await query(
  "total order count",
  `query { ordersCount(limit: 10000) { count precision } }`,
);
if (countData?.ordersCount) {
  console.log(`  Total orders in store: ${countData.ordersCount.count} (${countData.ordersCount.precision})`);
}
console.log("");

// 3. Most recent 5 orders (no date filter)
const recent = await query(
  "5 most recent orders (no filter)",
  `query {
    orders(first: 5, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        createdAt
        displayFinancialStatus
        cancelledAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        subtotalPriceSet { shopMoney { amount } }
      }
    }
  }`,
);
if (recent?.orders?.nodes) {
  console.log(`  ${recent.orders.nodes.length} most recent orders:`);
  for (const o of recent.orders.nodes) {
    console.log(`    ${o.name.padEnd(8)}  ${o.createdAt}  ${o.displayFinancialStatus.padEnd(10)}  $${o.subtotalPriceSet.shopMoney.amount}  cancelled=${o.cancelledAt ? "YES" : "no"}`);
  }
}
console.log("");

// 4. Same query as our sync — exactly what cron uses
const todayDate = new Date();
todayDate.setUTCDate(todayDate.getUTCDate() - 1); // yesterday UTC
const startIso = `${todayDate.toISOString().slice(0, 10)}T04:00:00.000Z`;
const endTime = new Date(todayDate);
endTime.setUTCDate(endTime.getUTCDate() + 1);
const endIso = `${endTime.toISOString().slice(0, 10)}T04:00:00.000Z`;

const syncStyle = await query(
  `sync-style query (window ${startIso} → ${endIso})`,
  `query DailyOrders($query: String!) {
    orders(first: 100, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage }
      nodes {
        name
        createdAt
        cancelledAt
        subtotalPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }`,
  { query: `created_at:>=${startIso} created_at:<${endIso}` },
);
if (syncStyle?.orders) {
  console.log(`  Found ${syncStyle.orders.nodes.length} orders for that window`);
  for (const o of syncStyle.orders.nodes) {
    console.log(`    ${o.name.padEnd(8)}  ${o.createdAt}  $${o.subtotalPriceSet.shopMoney.amount}  cancelled=${o.cancelledAt ? "YES" : "no"}`);
  }
}
console.log("");

// 5. Last 7 days, any orders?
const sevenDaysAgo = new Date();
sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
const weekStart = sevenDaysAgo.toISOString();

const week = await query(
  `last 7 days (since ${weekStart.slice(0, 10)})`,
  `query Week($query: String!) {
    orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes { name createdAt subtotalPriceSet { shopMoney { amount } } cancelledAt }
    }
  }`,
  { query: `created_at:>=${weekStart}` },
);
if (week?.orders?.nodes) {
  console.log(`  ${week.orders.nodes.length} orders in last 7 days`);
  for (const o of week.orders.nodes.slice(0, 10)) {
    console.log(`    ${o.name.padEnd(8)}  ${o.createdAt}  $${o.subtotalPriceSet.shopMoney.amount}  cancelled=${o.cancelledAt ? "YES" : "no"}`);
  }
}
console.log("");

// 6. Check access scopes
const scopes = await query(
  "app access scopes",
  `query { currentAppInstallation { accessScopes { handle } } }`,
);
if (scopes?.currentAppInstallation?.accessScopes) {
  const list = scopes.currentAppInstallation.accessScopes.map((s) => s.handle);
  console.log(`  Token scopes: ${list.join(", ")}`);
  const hasReadOrders = list.includes("read_orders");
  console.log(`  read_orders scope: ${hasReadOrders ? "✓ YES" : "✗ NO"}`);
  console.log(`  read_all_orders scope: ${list.includes("read_all_orders") ? "✓ YES" : "(not required for recent orders)"}`);
}
console.log("");

console.log("── DIAGNOSIS COMPLETE ──");
console.log(
  "If 'most recent orders' returns nothing but Shopify Admin shows orders,",
);
console.log("the token likely lacks read_orders scope OR can only see orders");
console.log("created via the channels it's installed in.");

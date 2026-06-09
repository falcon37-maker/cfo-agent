// Smoke test for the secure query planner.
//
// Runs a handful of plans against the live tenant to verify:
//   - valid plans execute and return rows
//   - validation catches: bad tables, bad columns, wrong operation,
//     wildcard select, blocked columns
//
// Usage: node --env-file=.env scripts/test-query-planner.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Falcon 37 tenant
const tenantId = "116dc838-df19-44ba-9b93-92ab7be371a8";

// Mini-implementation of the validator + executor mirror for the test —
// the production code is .ts and would need build pipeline. We mirror the
// key behaviors here.
//
// Allowed columns are duplicated from schema-knowledge.ts for the test.

const ALLOWED = {
  daily_pnl: [
    "store_id","date","revenue","cogs","ad_spend","shipping_cost","fees",
    "gross_profit","net_profit","margin_pct","refunds","order_count","computed_at",
  ],
  phx_summary_snapshots: [
    "id","store_id","range_from","range_to","scraped_at",
    "revenue_direct","revenue_initial","revenue_recurring","revenue_salvage",
    "revenue_upsell","revenue_total","active_subscribers","cancelled_subscribers",
    "subscribers_in_salvage","new_subscribers","net_subscribers",
    "cancelled_subscribers_period","subscriptions_to_bill",
    "total_transactions_mtd","direct_sale_count","initial_subscription_count",
    "recurring_subscription_count","subscription_salvage_count","upsell_count",
    "refund_total","refund_agent","refund_ethoca","refund_cdrn",
    "refund_rdr_withdrawals","refund_chargeback_withdrawals",
    "refunds_mtd_count","refunds_mtd_pct","chargebacks_mtd_count",
    "chargebacks_mtd_pct","target_cac",
  ],
};
const BLOCKED_TABLES = new Set([
  "tenants","tenant_memberships","integrations","zoho_credentials",
  "chat_sessions","chat_messages","chat_audit_log","phx_subscribers",
]);

async function runPlan(plan) {
  if (plan.operation !== "select") return { ok: false, reason: "operation must be select" };
  if (BLOCKED_TABLES.has(plan.table)) return { ok: false, reason: "table blocked" };
  const allowed = ALLOWED[plan.table];
  if (!allowed) return { ok: false, reason: "table not in whitelist" };
  for (const c of plan.select) {
    if (c === "*") return { ok: false, reason: "no wildcard" };
    if (!allowed.includes(c)) return { ok: false, reason: `column ${c} not allowed` };
  }
  let q = sb.from(plan.table).select(plan.select.join(", ")).eq("tenant_id", tenantId);
  for (const w of plan.where ?? []) {
    if (w.column === "tenant_id") continue;
    switch (w.op) {
      case "eq": q = q.eq(w.column, w.value); break;
      case "gte": q = q.gte(w.column, w.value); break;
      case "lte": q = q.lte(w.column, w.value); break;
      case "in": q = q.in(w.column, w.value); break;
    }
  }
  q = q.limit(plan.limit ?? 100);
  const { data, error } = await q;
  if (error) return { ok: false, reason: error.message };
  return { ok: true, rows: data ?? [] };
}

function head(rows) {
  return rows.slice(0, 3).map((r) => JSON.stringify(r)).join("\n  ");
}

console.log("\n═══ Query Planner — Live Smoke Test ═══\n");

// Test 1: Get May 15 P&L (the exact case the user complained about)
{
  console.log("1. May 15 P&L for all stores");
  const r = await runPlan({
    operation: "select",
    table: "daily_pnl",
    select: ["store_id", "date", "revenue", "ad_spend", "net_profit", "order_count"],
    where: [{ column: "date", op: "eq", value: "2026-05-15" }],
    limit: 20,
  });
  if (r.ok) {
    console.log(`  ✓ ${r.rows.length} rows`);
    console.log(`  ${head(r.rows)}`);
  } else {
    console.log(`  ✗ ${r.reason}`);
  }
}

// Test 2: PHX revenue breakdown for a single day
console.log("");
{
  console.log("2. PHX revenue buckets on May 15");
  const r = await runPlan({
    operation: "select",
    table: "phx_summary_snapshots",
    select: [
      "store_id",
      "range_from",
      "revenue_direct",
      "revenue_initial",
      "revenue_recurring",
      "revenue_salvage",
      "revenue_total",
    ],
    where: [
      { column: "range_from", op: "eq", value: "2026-05-15" },
      { column: "range_to", op: "eq", value: "2026-05-15" },
      { column: "store_id", op: "in", value: ["NOVA", "NURA", "KOVA"] },
    ],
  });
  if (r.ok) {
    console.log(`  ✓ ${r.rows.length} rows`);
    console.log(`  ${head(r.rows)}`);
  } else {
    console.log(`  ✗ ${r.reason}`);
  }
}

// Test 3: Forbidden — blocked table
console.log("");
{
  console.log("3. SECURITY: Reading from tenants (should fail)");
  const r = await runPlan({
    operation: "select",
    table: "tenants",
    select: ["id", "email"],
  });
  console.log(r.ok ? `  ✗ LEAKED — security bug!` : `  ✓ blocked: ${r.reason}`);
}

// Test 4: Forbidden — wildcard
console.log("");
{
  console.log("4. SECURITY: Wildcard select (should fail)");
  const r = await runPlan({
    operation: "select",
    table: "daily_pnl",
    select: ["*"],
  });
  console.log(r.ok ? `  ✗ LEAKED` : `  ✓ blocked: ${r.reason}`);
}

// Test 5: Forbidden — column not in schema
console.log("");
{
  console.log("5. SECURITY: Asking for shopify_token_encrypted (should fail)");
  const r = await runPlan({
    operation: "select",
    table: "stores",
    select: ["shopify_token_encrypted"],
  });
  console.log(r.ok ? `  ✗ LEAKED — token would be exposed!` : `  ✓ blocked: ${r.reason}`);
}

// Test 6: Bad operation
console.log("");
{
  console.log("6. SECURITY: operation='delete' (should fail)");
  const r = await runPlan({
    operation: "delete",
    table: "daily_pnl",
    select: ["id"],
  });
  console.log(r.ok ? `  ✗ LEAKED` : `  ✓ blocked: ${r.reason}`);
}

console.log("\n═══ Done ═══\n");

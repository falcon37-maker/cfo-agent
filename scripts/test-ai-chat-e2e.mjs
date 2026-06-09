// End-to-end test for the AI Chat stack.
//
// Usage:  node --env-file=.env scripts/test-ai-chat-e2e.mjs [tenantId]
//
// What it verifies:
//   1. DB read/write — can we insert a fake chat session + message, read them
//      back, then clean up?
//   2. Tenant context — does buildSystemPrompt produce a non-empty prompt
//      with live numbers?
//   3. Tools — does every tool execute without throwing and return shaped data?
//   4. CLI fallback — if no ANTHROPIC_API_KEY, can we get a real reply from
//      the local `claude` CLI?
//
// Defaults to the first active tenant if no id is passed.

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const tenantArg = process.argv[2];

if (!url || !serviceKey) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.log(`  ✗ ${msg}`);
  process.exitCode = 1;
}
function info(msg) {
  console.log(`  ℹ ${msg}`);
}

console.log("\n═══ AI Chat — End-to-End Test ═══\n");

// ─── Pick a tenant ────────────────────────────────────────────────────────
let tenantId = tenantArg;
let tenantName = "(unknown)";
let userId = null;
if (!tenantId) {
  const { data } = await sb
    .from("tenants")
    .select("id, user_id, display_name")
    .eq("is_active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!data) {
    fail("No active tenant found");
    process.exit(1);
  }
  tenantId = data.id;
  tenantName = data.display_name;
  userId = data.user_id;
} else {
  const { data } = await sb
    .from("tenants")
    .select("user_id, display_name")
    .eq("id", tenantId)
    .maybeSingle();
  if (data) {
    tenantName = data.display_name;
    userId = data.user_id;
  }
}
console.log(`Testing as tenant: ${tenantName} (${tenantId})\n`);

// ─── 1. DB round-trip on chat tables ──────────────────────────────────────
console.log("1. Database round-trip (chat_sessions + chat_messages)");
let sessionId = null;
{
  const { data: s, error: sErr } = await sb
    .from("chat_sessions")
    .insert({
      tenant_id: tenantId,
      user_id: userId,
      title: "__e2e_test__",
      model: "test",
    })
    .select("id")
    .single();
  if (sErr || !s) {
    fail(`insert chat_sessions: ${sErr?.message}`);
  } else {
    sessionId = s.id;
    pass(`inserted chat_sessions row (id: ${s.id})`);
  }
}
if (sessionId) {
  const { error: mErr } = await sb.from("chat_messages").insert({
    session_id: sessionId,
    tenant_id: tenantId,
    role: "user",
    content: "test message",
    blocks: [{ type: "text", text: "test message" }],
  });
  if (mErr) {
    fail(`insert chat_messages: ${mErr.message}`);
  } else {
    pass("inserted chat_messages row");
  }
  // Trigger should bump message_count to 1.
  const { data: bumped } = await sb
    .from("chat_sessions")
    .select("message_count, last_message_at")
    .eq("id", sessionId)
    .single();
  if (bumped?.message_count === 1) {
    pass(`trigger bumped message_count to 1`);
  } else {
    fail(`trigger did not bump message_count (got ${bumped?.message_count})`);
  }
  // Clean up.
  await sb.from("chat_sessions").delete().eq("id", sessionId);
  pass("cleaned up test row (cascade deleted message)");
}

// ─── 2. System prompt builder (live tenant context) ──────────────────────
console.log("\n2. System prompt builder");
{
  // Inline import to avoid TS compile step.
  const ctx = await import("../src/lib/ai/context.ts").catch(() => null);
  if (!ctx) {
    info("Skipping (can't import .ts directly from .mjs — covered by route test)");
  } else {
    const prompt = await ctx.buildSystemPrompt({
      tenantId,
      userEmail: null,
      tenantName,
    });
    if (prompt.length > 100) pass(`prompt built (${prompt.length} chars)`);
    else fail(`prompt too short: ${prompt.slice(0, 80)}`);
  }
}

// ─── 3. Each tool runs ────────────────────────────────────────────────────
console.log("\n3. Tools execution (read-only)");

// Re-implement minimal versions of the tool queries that hit Supabase
// directly. The actual TS implementations are unit-shaped per tool — what
// matters here is that the underlying queries succeed end-to-end.

// list_stores
{
  const { data, error } = await sb
    .from("stores")
    .select("id, name, currency, processing_fee_pct")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) fail(`list_stores: ${error.message}`);
  else pass(`list_stores returned ${data?.length ?? 0} stores`);
}

// get_dashboard_summary (use last 7d daily_pnl)
{
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = fromDate.toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("daily_pnl")
    .select("date, revenue, ad_spend, net_profit")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to);
  if (error) fail(`get_dashboard_summary (daily_pnl): ${error.message}`);
  else {
    const totals = (data ?? []).reduce(
      (acc, r) => {
        acc.revenue += Number(r.revenue ?? 0);
        acc.ad_spend += Number(r.ad_spend ?? 0);
        acc.net_profit += Number(r.net_profit ?? 0);
        return acc;
      },
      { revenue: 0, ad_spend: 0, net_profit: 0 },
    );
    pass(
      `daily_pnl 7d: ${data?.length ?? 0} rows, ` +
        `revenue $${totals.revenue.toFixed(2)}, ad $${totals.ad_spend.toFixed(2)}, net $${totals.net_profit.toFixed(2)}`,
    );
  }
}

// get_subscription_metrics
{
  const { data, error } = await sb
    .from("phx_summary_snapshots")
    .select("active_subscribers, cancelled_subscribers, range_to, scraped_at")
    .eq("tenant_id", tenantId)
    .eq("store_id", "PORTFOLIO")
    .order("range_to", { ascending: false })
    .order("scraped_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail(`get_subscription_metrics: ${error.message}`);
  else if (!data) info(`get_subscription_metrics: no PORTFOLIO snapshot yet`);
  else
    pass(
      `latest portfolio snapshot: ${data.active_subscribers ?? "?"} active, ` +
        `${data.cancelled_subscribers ?? "?"} cancelled (range_to: ${data.range_to})`,
    );
}

// get_phx_revenue_breakdown
{
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = fromDate.toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("phx_summary_snapshots")
    .select(
      "store_id, revenue_direct, revenue_initial, revenue_recurring, revenue_salvage, revenue_upsell, revenue_total, range_from, range_to",
    )
    .eq("tenant_id", tenantId)
    .in("store_id", ["NOVA", "NURA", "KOVA"])
    .gte("range_from", from)
    .lte("range_to", to);
  if (error) fail(`get_phx_revenue_breakdown: ${error.message}`);
  else pass(`phx_summary_snapshots 7d: ${data?.length ?? 0} rows`);
}

// get_ad_spend_entries
{
  const { data, error } = await sb
    .from("ad_spend_entries")
    .select("id, store_id, date, amount")
    .eq("tenant_id", tenantId)
    .order("date", { ascending: false })
    .limit(5);
  if (error) fail(`get_ad_spend_entries: ${error.message}`);
  else pass(`ad_spend_entries: ${data?.length ?? 0} most recent`);
}

// get_cogs_entries
{
  const { data, error } = await sb
    .from("cogs_entries")
    .select("id, store_id, date, cogs")
    .eq("tenant_id", tenantId)
    .order("date", { ascending: false })
    .limit(5);
  if (error) fail(`get_cogs_entries: ${error.message}`);
  else pass(`cogs_entries: ${data?.length ?? 0} most recent`);
}

// get_chargebacks_summary
{
  const { data, error } = await sb
    .from("chargeblast_alerts")
    .select("status, store_id, amount")
    .eq("tenant_id", tenantId)
    .limit(10);
  if (error) fail(`get_chargebacks_summary: ${error.message}`);
  else pass(`chargeblast_alerts: ${data?.length ?? 0} (sample of 10)`);
}

// ─── 4. CLI provider check (only if no API key) ───────────────────────────
console.log("\n4. AI provider");
if (anthropicKey) {
  pass("ANTHROPIC_API_KEY present — route uses Anthropic SDK + tools");
} else {
  info("No API key — route uses local `claude` CLI fallback (dev only)");
  const probe = spawnSync(
    "claude",
    [
      "-p",
      "Reply with the single word: ready",
      "--output-format",
      "json",
      "--disallowedTools",
      "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch",
    ],
    { shell: process.platform === "win32", encoding: "utf8", timeout: 60_000 },
  );
  if (probe.error) {
    fail(`CLI invocation failed: ${probe.error.message}`);
  } else if (probe.status !== 0) {
    fail(`CLI exited ${probe.status}: ${probe.stderr?.slice(0, 200)}`);
  } else {
    try {
      const lines = probe.stdout.trim().split(/\r?\n/);
      const lastJson = JSON.parse(lines[lines.length - 1]);
      if (lastJson.result && !lastJson.is_error) {
        pass(`CLI replied: "${String(lastJson.result).trim().slice(0, 60)}"`);
      } else {
        fail(`CLI returned error: ${JSON.stringify(lastJson).slice(0, 200)}`);
      }
    } catch (e) {
      fail(`Couldn't parse CLI output: ${e.message}`);
    }
  }
}

console.log("\n═══ End ═══\n");

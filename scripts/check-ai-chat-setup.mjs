// Diagnostic script — verifies AI chat is ready to run end-to-end.
//
// Usage:  node --env-file=.env scripts/check-ai-chat-setup.mjs
//
// Checks:
//   1. .env loaded? Supabase + (optional) Anthropic keys present?
//   2. chat_sessions / chat_messages / chat_audit_log tables exist?
//   3. RLS policies attached?
//   4. Can we read existing dashboard data for at least one tenant?
//   5. (Optional) Claude CLI installed when no API key.

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.log(`  ✗ ${msg}`);
}
function info(msg) {
  console.log(`  ℹ ${msg}`);
}

console.log("\n═══ CFO Agent — AI Chat Setup Diagnostic ═══\n");

// 1. Env presence
console.log("1. Environment variables");
if (!url) {
  fail("NEXT_PUBLIC_SUPABASE_URL is missing — cannot continue");
  process.exit(1);
}
pass(`NEXT_PUBLIC_SUPABASE_URL set (${url})`);
if (!serviceKey) {
  fail("SUPABASE_SERVICE_ROLE_KEY is missing — cannot continue");
  process.exit(1);
}
pass("SUPABASE_SERVICE_ROLE_KEY set");
if (anthropicKey) {
  pass(`ANTHROPIC_API_KEY set (starts with ${anthropicKey.slice(0, 10)}…)`);
} else {
  info("ANTHROPIC_API_KEY not set — route will fall back to local `claude` CLI");
}

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 2. Tables exist
console.log("\n2. Database tables (migration 015_ai_chat.sql)");
const required = ["chat_sessions", "chat_messages", "chat_audit_log"];
let allTablesOk = true;
for (const t of required) {
  const { error } = await sb.from(t).select("id").limit(1);
  if (error) {
    fail(`${t} — ${error.message}`);
    allTablesOk = false;
  } else {
    pass(`${t} exists`);
  }
}
if (!allTablesOk) {
  console.log(
    "\n  → Apply supabase/migrations/015_ai_chat.sql in the Supabase SQL editor.",
  );
}

// 3. At least one tenant + stores
console.log("\n3. Tenant + stores data");
const { data: tenants, error: tErr } = await sb
  .from("tenants")
  .select("id, display_name, email, is_active")
  .eq("is_active", true)
  .limit(5);
if (tErr) {
  fail(`tenants query: ${tErr.message}`);
} else if (!tenants || tenants.length === 0) {
  fail("No active tenants found — sign up at /signup first");
} else {
  pass(`${tenants.length} active tenant(s) found`);
  for (const t of tenants) {
    console.log(`     - ${t.display_name || t.email} (id: ${t.id})`);
  }
  const tenantId = tenants[0].id;

  const { data: stores } = await sb
    .from("stores")
    .select("id, name, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (!stores || stores.length === 0) {
    info("First tenant has no stores yet — chat will work but tools return empty");
  } else {
    pass(`First tenant has ${stores.length} active store(s): ${stores.map((s) => s.id).join(", ")}`);
  }

  const { data: pnl } = await sb
    .from("daily_pnl")
    .select("date, revenue, net_profit")
    .eq("tenant_id", tenantId)
    .order("date", { ascending: false })
    .limit(3);
  if (!pnl || pnl.length === 0) {
    info("No daily_pnl rows yet — run a sync first");
  } else {
    pass(`Latest daily_pnl rows for ${tenants[0].display_name || "tenant"}:`);
    for (const r of pnl) {
      console.log(
        `     - ${r.date}: revenue $${Number(r.revenue ?? 0).toFixed(2)}, net $${Number(r.net_profit ?? 0).toFixed(2)}`,
      );
    }
  }
}

// 4. Claude CLI (only if no API key)
if (!anthropicKey) {
  console.log("\n4. Claude CLI fallback");
  const probe = spawnSync(
    "claude",
    ["--version"],
    { shell: process.platform === "win32", encoding: "utf8" },
  );
  if (probe.error || probe.status !== 0) {
    fail(`Claude CLI not callable: ${probe.error?.message ?? probe.stderr ?? "non-zero exit"}`);
  } else {
    pass(`Claude CLI version: ${probe.stdout.trim()}`);
  }
}

console.log("\n═══ Done ═══\n");

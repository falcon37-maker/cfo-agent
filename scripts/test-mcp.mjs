// Smoke-test the remote MCP server end to end.
//
// Usage:
//   node scripts/test-mcp.mjs [baseUrl] [token]
//   node scripts/test-mcp.mjs http://localhost:3000/mcp a690b432...
//
// Defaults: baseUrl=http://localhost:3000/mcp, token=$MCP_TOKEN env.
// Runs: 401 check → initialize → tools/list → a few safe read calls.
// Does NOT call label_transaction / apply_label_to_zoho (those write).

const URL = process.argv[2] || "http://localhost:3000/mcp";
const TOKEN = process.argv[3] || process.env.MCP_TOKEN || "";

const HEADERS = (tok) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
});

let idCounter = 1;

async function rpc(method, params, tok = TOKEN) {
  const res = await fetch(URL, {
    method: "POST",
    headers: HEADERS(tok),
    body: JSON.stringify({ jsonrpc: "2.0", id: idCounter++, method, params }),
  });
  const text = await res.text();
  // Streamable-HTTP replies as SSE: pull the JSON out of the `data:` line.
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = line ? JSON.parse(line.slice(6)) : safeJson(text);
  return { status: res.status, body };
}

function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }

function ok(label) { console.log(`  ✓ ${label}`); }
function fail(label, extra) { console.log(`  ✗ ${label}${extra ? "  " + extra : ""}`); process.exitCode = 1; }

async function callTool(name, args = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  if (body?.result?.isError) throw new Error(body.result.content?.[0]?.text || "tool error");
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : body?.result;
}

console.log(`\n═══ MCP smoke test ═══`);
console.log(`  URL:   ${URL}`);
console.log(`  Token: ${TOKEN ? TOKEN.slice(0, 8) + "…" : "(none)"}\n`);

// 1. Unauthorized
{
  const r = await fetch(URL, {
    method: "POST",
    headers: HEADERS(""),
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  r.status === 401 ? ok("no token → 401") : fail("no token should be 401", `got ${r.status}`);
}

if (!TOKEN) { console.log("\n  (no token given — stopping after 401 check)\n"); process.exit(process.exitCode || 0); }

// 2. initialize
{
  const { status, body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1.0" } });
  status === 200 && body?.result?.serverInfo?.name
    ? ok(`initialize → ${body.result.serverInfo.name} v${body.result.serverInfo.version}`)
    : fail("initialize failed", JSON.stringify(body).slice(0, 200));
}

// 3. tools/list
let toolNames = [];
{
  const { body } = await rpc("tools/list", {});
  toolNames = (body?.result?.tools || []).map((t) => t.name);
  toolNames.length >= 13 ? ok(`tools/list → ${toolNames.length} tools`) : fail(`expected ≥13 tools`, `got ${toolNames.length}`);
  console.log(`      ${toolNames.join(", ")}`);
}

// 4. Safe read calls
try {
  const stores = await callTool("list_stores");
  ok(`list_stores → ${stores?.stores?.length ?? "?"} stores`);
} catch (e) { fail("list_stores", e.message); }

try {
  const cats = await callTool("list_zoho_categories");
  ok(`list_zoho_categories → ${cats.length} categories`);
} catch (e) { fail("list_zoho_categories", e.message); }

try {
  const applied = await callTool("list_staged_labels", { status: "applied" });
  ok(`list_staged_labels(applied) → ${applied.length} rows`);
} catch (e) { fail("list_staged_labels", e.message); }

try {
  const un = await callTool("list_uncategorized_transactions", { limit: 5 });
  ok(`list_uncategorized_transactions(limit 5) → ${un.length} rows`);
} catch (e) { fail("list_uncategorized_transactions", e.message); }

console.log(process.exitCode ? "\n✗ some checks failed\n" : "\n✓ all checks passed\n");

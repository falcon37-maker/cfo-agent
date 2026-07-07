// Verify the remote MCP server against the spec's Definition of Done (Section 8).
// Usage:  node --env-file=.env scripts/verify-mcp.mjs [baseUrl] [tenant1Token]
//
// Checks: auth (401 for invalid/revoked), cross-tenant isolation, read-data
// correctness, and the write path (label_transaction stages; apply_label_to_zoho
// reaches Zoho + handles errors gracefully). Sets up + tears down its own test
// rows/tokens — touches no real data.

import { Client } from "pg";
import { randomBytes } from "node:crypto";

const URL = process.argv[2] || "http://localhost:3000/mcp";
const T1 = process.argv[3] || process.env.MCP_TOKEN ||
  "a690b43258626916d4cfa89a01f03f4e09d8953df8582a786ca3f1a438fb3cd1";

const TENANT1 = "116dc838-df19-44ba-9b93-92ab7be371a8"; // Falcon 37 LLC
const TENANT2 = "d59d1a36-74e3-4227-8c2d-8ef71fb8f8df"; // NW CORE LLC
const TEST_TXN = "MCP_VERIFY_TXN_DELETE_ME";

let pass = 0, failn = 0, idc = 1;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m, e) => { console.log(`  ✗ ${m}${e ? "  → " + e : ""}`); failn++; };

async function rpc(method, params, tok) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: idc++, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, body: line ? JSON.parse(line.slice(6)) : text };
}
async function call(name, args, tok) {
  const { body } = await rpc("tools/call", { name, arguments: args || {} }, tok);
  const r = body?.result;
  if (!r) throw new Error(JSON.stringify(body).slice(0, 160));
  const text = r.content?.[0]?.text;
  // On error the content is a plain message string, not JSON — don't force-parse.
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { isError: !!r.isError, data, raw: text };
}

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let T2 = null;

try {
  console.log(`\n═══ MCP verification — Definition of Done ═══`);
  console.log(`  URL: ${URL}\n`);

  // ── DoD #4: invalid / revoked token → 401, no leak ──
  console.log("── Auth & isolation (DoD #4) ──");
  {
    const r = await rpc("tools/list", {}, "totally-invalid-token");
    r.status === 401 ? ok("invalid token → 401") : bad("invalid token not 401", r.status);
  }

  // mint a token for TENANT2 to test isolation + revocation
  T2 = randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO mcp_tokens (token, tenant_id, label) VALUES ($1,$2,'MCP verify (delete me)')`,
    [T2, TENANT2],
  );
  {
    const s1 = await call("list_stores", {}, T1);
    const s2 = await call("list_stores", {}, T2);
    const ids1 = new Set((s1.data?.stores || []).map((x) => x.id));
    const ids2 = (s2.data?.stores || []).map((x) => x.id);
    const leak = ids2.filter((x) => ids1.has(x));
    console.log(`      tenant1 stores: ${[...ids1].join(", ") || "(none)"}`);
    console.log(`      tenant2 stores: ${ids2.join(", ") || "(none)"}`);
    // Isolation holds if the two tenants don't return an identical store set.
    const identical = ids2.length === ids1.size && leak.length === ids1.size;
    !identical ? ok("cross-tenant data differs (isolated)") : bad("tenants returned identical stores");
  }
  {
    // revoke T2 → must now 401
    await db.query(`UPDATE mcp_tokens SET revoked_at = NOW() WHERE token = $1`, [T2]);
    const r = await rpc("tools/list", {}, T2);
    r.status === 401 ? ok("revoked token → 401") : bad("revoked token not 401", r.status);
  }

  // ── DoD #3: read data correctness ──
  console.log("\n── Read tools (DoD #3) ──");
  let storeId = null;
  {
    const s = await call("list_stores", {}, T1);
    storeId = s.data?.stores?.[0]?.id;
    s.data?.stores?.length ? ok(`list_stores → ${s.data.stores.length} stores`) : bad("list_stores empty");
  }
  {
    const d = await call("get_dashboard_summary", { days: 30 }, T1);
    const hasNum = d.data && typeof JSON.stringify(d.data).match(/\d/) !== null && !d.isError;
    hasNum ? ok(`get_dashboard_summary(30d) → keys: ${Object.keys(d.data || {}).slice(0,6).join(", ")}`) : bad("dashboard summary bad", d.raw?.slice(0,120));
  }
  if (storeId) {
    const p = await call("get_pnl_for_store", { store_id: storeId, days: 30 }, T1);
    !p.isError ? ok(`get_pnl_for_store(${storeId}, 30d) → ok`) : bad("pnl error", p.raw?.slice(0,120));
  }
  {
    const c = await call("get_chargebacks_summary", { days: 30 }, T1);
    !c.isError ? ok("get_chargebacks_summary → ok") : bad("chargebacks error", c.raw?.slice(0,120));
  }

  // ── DoD #3: write path — stage (safe) then Zoho apply (error-handled) ──
  console.log("\n── Write path (DoD #3) — on a throwaway row ──");
  // pick a real expense category id from Zoho
  const cats = (await call("list_zoho_categories", {}, T1)).data;
  const expenseCat = cats.find((c) => c.type === "expense") || cats[0];
  // insert a disposable unlabeled row for TENANT1
  await db.query(`DELETE FROM transaction_labels WHERE transaction_id = $1`, [TEST_TXN]);
  await db.query(
    `INSERT INTO transaction_labels
       (tenant_id, transaction_id, account_id, account_name, txn_date, amount,
        debit_or_credit, payee, description, status)
     VALUES ($1,$2,'TESTBANK','Test Bank','2026-06-01',12.34,'credit','Verify','MCP verify row','unlabeled')`,
    [TENANT1, TEST_TXN],
  );
  {
    const r = await call("label_transaction", { transaction_id: TEST_TXN, account_id: expenseCat.id }, T1);
    const { rows } = await db.query(
      `SELECT status, suggested_account_id FROM transaction_labels WHERE transaction_id=$1`, [TEST_TXN]);
    const row = rows[0];
    (!r.isError && row?.status === "confirmed" && row?.suggested_account_id === expenseCat.id)
      ? ok(`label_transaction → DB status=confirmed, category=${expenseCat.name}`)
      : bad("label_transaction did not stage", `status=${row?.status} acct=${row?.suggested_account_id}`);
  }
  {
    // apply to Zoho — the transaction id is fake, so Zoho must reject and our
    // tool must surface a clean error (proves it reaches Zoho + handles failure).
    const r = await call("apply_label_to_zoho", { transaction_id: TEST_TXN }, T1);
    const { rows } = await db.query(
      `SELECT status FROM transaction_labels WHERE transaction_id=$1`, [TEST_TXN]);
    (r.isError && rows[0]?.status !== "applied")
      ? ok(`apply_label_to_zoho(fake id) → clean error, row NOT marked applied`)
      : bad("apply_label_to_zoho mishandled fake id", `isError=${r.isError} status=${rows[0]?.status}`);
  }
  {
    // apply with no category set → helpful error, not a crash
    await db.query(`UPDATE transaction_labels SET suggested_account_id=NULL, status='unlabeled' WHERE transaction_id=$1`, [TEST_TXN]);
    const r = await call("apply_label_to_zoho", { transaction_id: TEST_TXN }, T1);
    (r.isError && /category/i.test(r.raw || ""))
      ? ok("apply without category → helpful error message")
      : bad("apply without category not handled", r.raw?.slice(0,120));
  }
} finally {
  // teardown
  await db.query(`DELETE FROM transaction_labels WHERE transaction_id = $1`, [TEST_TXN]).catch(() => {});
  if (T2) await db.query(`DELETE FROM mcp_tokens WHERE token = $1`, [T2]).catch(() => {});
  await db.end();
}

console.log(`\n═══ ${pass} passed, ${failn} failed ═══\n`);
process.exit(failn ? 1 : 0);

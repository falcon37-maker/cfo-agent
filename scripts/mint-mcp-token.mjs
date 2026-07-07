// Mint a remote-MCP bearer token for a tenant and print it ONCE.
//
// Usage:
//   node --env-file=.env scripts/mint-mcp-token.mjs [tenantId] ["label"]
//
// If tenantId is omitted, the first tenant in `tenants` is used (single-tenant
// setups). The token is a 32-byte hex string; paste it into Claude Desktop /
// Claude.ai as the connector's bearer token. Store it safely — it is shown only
// here.

import { Client } from "pg";
import { randomBytes } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const argTenant = process.argv[2];
const label = process.argv[3] ?? "MCP connector";

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  let tenantId = argTenant;
  if (!tenantId) {
    const { rows } = await c.query(
      `SELECT id, display_name FROM tenants ORDER BY created_at ASC LIMIT 1`,
    );
    if (!rows[0]) throw new Error("no tenants found — pass a tenantId");
    tenantId = rows[0].id;
    console.log(`Using tenant: ${rows[0].display_name ?? tenantId} (${tenantId})`);
  }

  const token = randomBytes(32).toString("hex");
  await c.query(
    `INSERT INTO mcp_tokens (token, tenant_id, label) VALUES ($1, $2, $3)`,
    [token, tenantId, label],
  );

  console.log(`\n═══ MCP token minted ═══`);
  console.log(`  tenant: ${tenantId}`);
  console.log(`  label : ${label}`);
  console.log(`\n  TOKEN (copy now — shown only once):\n`);
  console.log(`  ${token}\n`);
  console.log(`  Connector URL:  https://<your-host>/mcp`);
  console.log(`  Header:         Authorization: Bearer ${token.slice(0, 8)}…\n`);
} catch (e) {
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

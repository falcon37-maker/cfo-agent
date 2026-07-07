// Apply migration 027_mcp_tool_calls.sql (MCP activity log). Usage:
//   node --env-file=.env scripts/apply-migration-027.mjs
//
// Pure additive: creates mcp_tool_calls + index, RLS disabled. Touches no
// existing tables or data. Verifies the table exists afterwards.

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const sql = await readFile("supabase/migrations/027_mcp_tool_calls.sql", "utf8");
const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 027_mcp_tool_calls.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}\n`);

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query(sql);
  const { rows } = await c.query(
    `SELECT to_regclass('public.mcp_tool_calls') AS tbl`,
  );
  if (!rows[0]?.tbl) throw new Error("table not created");
  const cols = (await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'mcp_tool_calls' ORDER BY ordinal_position`)).rows;
  console.log(`✓ table created: mcp_tool_calls`);
  console.log(`✓ columns: ${cols.map((r) => r.column_name).join(", ")}`);
  await c.query("COMMIT");
  console.log(`\n✓ Migration applied — additive only, no existing data touched.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

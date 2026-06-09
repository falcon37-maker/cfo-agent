// Apply migration 018_shopify_orders.sql.
// Idempotent: CREATE TABLE IF NOT EXISTS + indexes only — safe to re-run.
//
// Usage:  node --env-file=.env scripts/apply-migration-018.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = await readFile(
  "supabase/migrations/018_shopify_orders.sql",
  "utf8",
);

const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 018_shopify_orders.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}`);
console.log(`   Idempotent: yes`);
console.log("");

const c = new Client({ connectionString: DB_URL });
await c.connect();

try {
  await c.query("BEGIN");
  await c.query(sql);

  const { rows } = await c.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'shopify_orders'
       ORDER BY ordinal_position`,
  );
  if (rows.length === 0) {
    throw new Error("shopify_orders table not created");
  }
  console.log(`✓ shopify_orders has ${rows.length} columns:`);
  for (const r of rows) console.log(`    ${r.column_name}  (${r.data_type})`);

  await c.query("COMMIT");
  console.log(`\n✓ Migration applied.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Migration failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

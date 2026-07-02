// Apply migration 024_transaction_labels.sql (new staging table for AI
// transaction labeling). Additive only — CREATE TABLE IF NOT EXISTS.
// Usage:  node --env-file=.env scripts/apply-migration-024.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const sql = await readFile("supabase/migrations/024_transaction_labels.sql", "utf8");
const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 024_transaction_labels.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}\n`);

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query(sql);
  const { rows } = await c.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'transaction_labels'
    ORDER BY ordinal_position`);
  if (rows.length === 0) throw new Error("table transaction_labels not created");
  await c.query("COMMIT");
  console.log(`✓ table transaction_labels created with ${rows.length} columns:`);
  for (const r of rows) console.log(`   - ${r.column_name} (${r.data_type})`);
  console.log(`\n✓ Migration applied — no existing data touched.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

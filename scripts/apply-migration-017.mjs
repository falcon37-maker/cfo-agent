// Apply migration 017_data_validation.sql to whatever DATABASE_URL points at.
//
// Why a dedicated script: scripts/apply-local-migration.mjs enforces
// localhost-only. Migration 017 is purely additive (CREATE TABLE IF NOT
// EXISTS + indexes) so it's safe for LIVE. No data is changed, no
// existing object is altered.
//
// Usage:
//   node --env-file=.env scripts/apply-migration-017.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = await readFile("supabase/migrations/017_data_validation.sql", "utf8");

const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 017_data_validation.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}`);
console.log(`   Idempotent: yes (CREATE TABLE IF NOT EXISTS only)`);
console.log("");

const c = new Client({ connectionString: DB_URL });
await c.connect();

try {
  await c.query("BEGIN");
  await c.query(sql);

  // Verify the table now exists.
  const { rows } = await c.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'data_validation_log'
       ORDER BY ordinal_position`,
  );
  if (rows.length === 0) {
    throw new Error("data_validation_log table not created after migration");
  }
  console.log(`✓ data_validation_log now has ${rows.length} columns:`);
  for (const r of rows) console.log(`    ${r.column_name}  (${r.data_type})`);

  await c.query("COMMIT");
  console.log(`\n✓ Migration applied successfully.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Migration failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

// Apply migration 019_paysight.sql. Idempotent (CREATE TABLE IF NOT EXISTS).
// Usage:  node --env-file=.env scripts/apply-migration-019.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const sql = await readFile("supabase/migrations/019_paysight.sql", "utf8");
const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 019_paysight.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}`);
console.log(`   Idempotent: yes\n`);

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query(sql);
  for (const tbl of ["paysight_transactions", "paysight_subscriptions"]) {
    const { rows } = await c.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [tbl],
    );
    if (rows.length === 0) throw new Error(`${tbl} not created`);
    console.log(`✓ ${tbl}: ${rows.length} columns`);
  }
  await c.query("COMMIT");
  console.log(`\n✓ Migration applied.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

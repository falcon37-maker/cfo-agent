// Apply migration 021_paysight_billing_cycle.sql (additive columns only).
// Usage:  node --env-file=.env scripts/apply-migration-021.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const sql = await readFile(
  "supabase/migrations/021_paysight_billing_cycle.sql",
  "utf8",
);
const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 021_paysight_billing_cycle.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}`);
console.log(`   Additive only (ADD COLUMN IF NOT EXISTS)\n`);

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query(sql);
  const { rows } = await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'paysight_transactions'
      AND column_name IN ('payment_number','attempt','sub_id','store_name')
    ORDER BY column_name`);
  if (rows.length !== 4) throw new Error(`expected 4 new columns, found ${rows.length}`);
  console.log(`✓ columns: ${rows.map((r) => r.column_name).join(", ")}`);
  await c.query("COMMIT");
  console.log(`\n✓ Migration applied.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

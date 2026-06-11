// Apply migration 020_phx_snapshot_tenant_unique.sql.
// Usage:  node --env-file=.env scripts/apply-migration-020.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const sql = await readFile(
  "supabase/migrations/020_phx_snapshot_tenant_unique.sql",
  "utf8",
);
const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 020_phx_snapshot_tenant_unique.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}\n`);

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query(sql);
  const { rows } = await c.query(`
    SELECT conname FROM pg_constraint
    WHERE conname = 'phx_summary_snapshots_tenant_store_range_unique'`);
  if (rows.length === 0) throw new Error("new unique constraint not created");
  console.log(`✓ unique constraint now: ${rows[0].conname}`);
  await c.query("COMMIT");
  console.log(`\n✓ Migration applied.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

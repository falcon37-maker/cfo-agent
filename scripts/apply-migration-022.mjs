// Apply migration 022_phoenix_portal_provider.sql (widen provider CHECK).
// Usage:  node --env-file=.env scripts/apply-migration-022.mjs

import { Client } from "pg";
import { readFile } from "node:fs/promises";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

const sql = await readFile(
  "supabase/migrations/022_phoenix_portal_provider.sql",
  "utf8",
);
const isLive = !/localhost|127\.0\.0\.1/.test(DB_URL);
console.log(`\n═══ Applying migration 022_phoenix_portal_provider.sql ═══`);
console.log(`   Target: ${isLive ? "⚠ LIVE Supabase" : "localhost"}\n`);

const c = new Client({ connectionString: DB_URL });
await c.connect();
try {
  await c.query("BEGIN");

  // Row count BEFORE — must be identical after (no data touched).
  const before = (await c.query("SELECT count(*)::int AS n FROM integrations")).rows[0].n;
  // Confirm every existing provider value is in the NEW allowed set (so the
  // ADD can never fail on existing data).
  const bad = (await c.query(`
    SELECT DISTINCT provider FROM integrations
    WHERE provider NOT IN ('chargeblast','solvpath','zoho_books','phoenix_portal')`)).rows;
  if (bad.length) throw new Error(`existing rows would violate new check: ${bad.map(r=>r.provider).join(", ")}`);

  await c.query(sql);

  // verify phoenix_portal now allowed + row count unchanged
  const { rows } = await c.query(`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname = 'integrations_provider_check'`);
  if (!rows[0]?.def?.includes("phoenix_portal")) {
    throw new Error("constraint not updated");
  }
  const after = (await c.query("SELECT count(*)::int AS n FROM integrations")).rows[0].n;
  if (after !== before) throw new Error(`row count changed ${before} -> ${after}`);
  console.log(`✓ constraint: ${rows[0].def}`);
  console.log(`✓ integrations rows unchanged: ${before}`);
  await c.query("COMMIT");
  console.log(`\n✓ Migration applied — no data touched.`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n✗ Failed: ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}

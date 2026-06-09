// Apply a migration .sql file to LOCAL Postgres (cfo_agent).
//
// We deliberately keep this LOCAL-only. Live Supabase migrations go
// through the Supabase Dashboard once we've verified the SQL works here.
//
// Usage:
//   node --env-file=.env scripts/apply-local-migration.mjs <path-to-sql>
//
// Example:
//   node --env-file=.env scripts/apply-local-migration.mjs supabase/migrations/016_phase2_edits.sql

import { Client } from "pg";
import { readFile } from "node:fs/promises";

// Prefer LOCAL_DB_URL when explicitly set; otherwise fall back to
// DATABASE_URL (which is currently pointing at the local DB during
// Phase 2 development per .env).
const LOCAL = process.env.LOCAL_DB_URL || process.env.DATABASE_URL;
if (!LOCAL) {
  console.error("Missing LOCAL_DB_URL or DATABASE_URL");
  process.exit(1);
}
if (!/localhost|127\.0\.0\.1/.test(LOCAL)) {
  console.error(
    "Refusing to run: DATABASE_URL doesn't look local. " +
      "Set LOCAL_DB_URL explicitly, or point DATABASE_URL at localhost.",
  );
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/apply-local-migration.mjs <path-to-sql>");
  process.exit(1);
}

const sql = await readFile(file, "utf8");

// The migration references auth.users + tenant_memberships + auth.uid().
// Local Postgres doesn't have Supabase's auth schema, so we shim just
// enough for the migration to execute. Reads/writes will use the
// service-role-equivalent (plain postgres user) which bypasses RLS anyway.
const shim = `
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT
  );
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
    LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
`;

const c = new Client({ connectionString: LOCAL });
await c.connect();
try {
  console.log("Applying auth shim (idempotent)…");
  await c.query(shim);
  console.log("Applying migration:", file);
  await c.query(sql);
  console.log("✓ Migration applied");
} catch (e) {
  console.error("✗ Migration failed:", e.message);
  process.exit(1);
} finally {
  await c.end();
}

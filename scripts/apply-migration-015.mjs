// One-shot migration runner for 015_ai_chat.sql.
//
// Uses Supabase's pg-meta SQL endpoint via the service-role key. This is
// a convenience for local development; for production you should still
// apply migrations via the Supabase Dashboard or `supabase db push`.
//
// Usage:  node --env-file=.env scripts/apply-migration-015.mjs

import { readFile } from "node:fs/promises";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sql = await readFile("supabase/migrations/015_ai_chat.sql", "utf8");

// Supabase exposes /pg/query (pg-meta) for raw SQL. We need the postgres-meta
// internal endpoint, which lives at /database/query when using the REST API
// with service role. As a portable alternative we POST to /rest/v1/rpc/exec_sql
// — but that RPC doesn't exist by default. So we use the management API style
// via PostgREST is not possible.
//
// Cleanest path: hit the SQL endpoint at /pg-meta/default/query (only works
// for self-hosted) OR connect via pg directly. Easiest portable approach is
// to run the SQL through Supabase's `query` endpoint provided by postgres
// REST extensions. Since that's not guaranteed, we'll print clear instructions
// and let the user paste into Supabase SQL editor.

console.log("\n═══ Migration 015: ai_chat ═══\n");
console.log(
  "Direct SQL execution from a script requires extra setup. The reliable\n" +
  "path is to paste the migration into the Supabase SQL editor:\n",
);
console.log(`  1. Open: ${url.replace(".supabase.co", ".supabase.co/project/_/sql/new")}`);
console.log("  2. Paste the contents of supabase/migrations/015_ai_chat.sql");
console.log("  3. Click 'Run'");
console.log("\nMigration file location:");
console.log("  supabase/migrations/015_ai_chat.sql\n");
console.log("Size:", sql.length, "characters,", sql.split("\n").length, "lines\n");
console.log("After applying, re-run the diagnostic:");
console.log("  node --env-file=.env scripts/check-ai-chat-setup.mjs\n");

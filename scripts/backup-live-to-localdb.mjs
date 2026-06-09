// Backup LIVE Supabase Postgres → a brand-new local Postgres database.
//
// What it does:
//   1. DROPs and CREATEs a target database on the local Postgres
//      instance (default name: cfo_agent_backup_<timestamp>).
//   2. Connects to LIVE Supabase, reads every public-schema table's
//      schema + rows.
//   3. Recreates the same schema in the backup DB + copies all rows.
//   4. Prints a row-count summary and the backup DB name.
//
// Why a separate DB and not JSON dumps:
//   - Queryable. We can SELECT against the backup just like prod.
//   - Restorable. If we ever need to roll back, this DB IS the rollback.
//   - Versioned. Every run creates a timestamped DB so we keep history.
//
// Usage:
//   node --env-file=.env scripts/backup-live-to-localdb.mjs
//   node --env-file=.env scripts/backup-live-to-localdb.mjs --name=cfo_backup_manual

import { Client } from "pg";

const LIVE = process.env.LIVE_DATABASE_URL || process.env.DATABASE_URL;
if (!LIVE) {
  console.error("Missing LIVE_DATABASE_URL (or DATABASE_URL).");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(LIVE)) {
  console.error(
    "Refusing to back up — source URL is LOCAL. Set LIVE_DATABASE_URL to the Supabase pooler/direct URL.",
  );
  process.exit(1);
}

// Where do we create the backup database? Same Postgres host the rest of
// the project uses for local work. If you've renamed it, set
// LOCAL_PG_ADMIN_URL in .env (must point at the `postgres` database for
// the CREATE DATABASE call to succeed).
const LOCAL_ADMIN_URL =
  process.env.LOCAL_PG_ADMIN_URL ||
  "postgresql://postgres:password@localhost:5432/postgres";

const args = process.argv.slice(2);
const nameArg = args.find((a) => a.startsWith("--name="));
const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);
const BACKUP_DB = nameArg
  ? nameArg.slice("--name=".length)
  : `cfo_agent_backup_${stamp.replace(/-/g, "_")}`;

// Tables to copy. Order matters — parents before children so any future
// FK restoration runs cleanly.
const TABLES = [
  "tenants",
  "tenant_memberships",
  "pending_invitations",
  "stores",
  "products",
  "daily_orders",
  "daily_ad_spend",
  "daily_pnl",
  "cogs_entries",
  "ad_spend_entries",
  "manual_revenue_entries",
  "phx_summary_snapshots",
  "phx_subscribers",
  "phx_rebills",
  "phx_cohorts",
  "chargeblast_alerts",
  "integrations",
  "zoho_credentials",
  "chat_sessions",
  "chat_messages",
  "chat_audit_log",
  "pending_confirmations", // may not exist on LIVE yet — handled.
];

const BATCH = 1000;

console.log(`\n═══ LIVE → LOCAL DB BACKUP ═══\n`);
console.log(`Source: ${LIVE.replace(/:[^:@/]+@/, ":***@")}`);
console.log(`Target: ${LOCAL_ADMIN_URL.replace(/:[^:@/]+@/, ":***@")}`);
console.log(`Backup DB name: ${BACKUP_DB}\n`);

// ─── 1. Create the backup database ─────────────────────────────────────
{
  const admin = new Client({ connectionString: LOCAL_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${BACKUP_DB}"`);
    await admin.query(`CREATE DATABASE "${BACKUP_DB}"`);
    console.log(`✓ Created database "${BACKUP_DB}"\n`);
  } catch (e) {
    console.error(`✗ Could not create backup database:`, e.message);
    process.exit(1);
  } finally {
    await admin.end();
  }
}

// ─── 2. Open connections to LIVE (source) and backup DB (target) ──────
const live = new Client({
  connectionString: LIVE,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 120_000,
});
await live.connect();

// Compose the backup DB URL by swapping the database name in the admin URL.
const backupUrl = LOCAL_ADMIN_URL.replace(/\/[^/]+$/, `/${BACKUP_DB}`);
const target = new Client({ connectionString: backupUrl });
await target.connect();

// pgcrypto for gen_random_uuid() defaults that some tables use.
await target.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

// ─── 3. Per-table schema copy + row copy ──────────────────────────────
const summary = [];

function quoteIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function colDdl(row) {
  const name = quoteIdent(row.column_name);
  let type = row.udt_name;
  if (type === "numeric" && row.numeric_precision != null) {
    type = `numeric(${row.numeric_precision}${row.numeric_scale != null ? "," + row.numeric_scale : ""})`;
  }
  if (
    (type === "varchar" || type === "bpchar") &&
    row.character_maximum_length != null
  ) {
    type = `${type === "bpchar" ? "char" : "varchar"}(${row.character_maximum_length})`;
  }
  let line = `${name} ${type}`;
  if (row.is_nullable === "NO") line += " NOT NULL";
  if (row.column_default != null) {
    // Skip defaults that reference foreign schemas (auth.*, supabase_*)
    // — they'd break on a vanilla Postgres instance.
    if (!/auth\.|supabase_/i.test(row.column_default)) {
      line += ` DEFAULT ${row.column_default}`;
    }
  }
  return line;
}

for (const t of TABLES) {
  const t0 = Date.now();

  const existsRes = await live.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [t],
  );
  if (existsRes.rows.length === 0) {
    summary.push({ table: t, rows: 0, skipped: "not on live" });
    console.log(`  - ${t}: not on live, skipping`);
    continue;
  }

  // Pull schema metadata.
  const cols = await live.query(
    `SELECT column_name, udt_name, is_nullable, column_default,
            numeric_precision, numeric_scale, character_maximum_length,
            ordinal_position
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [t],
  );
  const pk = await live.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [t],
  );

  // Create the table in the backup DB.
  await target.query(`DROP TABLE IF EXISTS ${quoteIdent(t)} CASCADE`);
  const lines = cols.rows.map(colDdl);
  if (pk.rows.length > 0) {
    lines.push(
      `PRIMARY KEY (${pk.rows.map((r) => quoteIdent(r.column_name)).join(", ")})`,
    );
  }
  await target.query(
    `CREATE TABLE ${quoteIdent(t)} (\n  ${lines.join(",\n  ")}\n)`,
  );

  // Copy rows in batches.
  const orderCol =
    pk.rows[0]?.column_name
      ? quoteIdent(pk.rows[0].column_name)
      : quoteIdent(cols.rows[0].column_name);
  const colIdents = cols.rows
    .map((c) => quoteIdent(c.column_name))
    .join(", ");
  const colNames = cols.rows.map((c) => c.column_name);

  let total = 0;
  let offset = 0;
  while (true) {
    const { rows } = await live.query(
      `SELECT ${colIdents} FROM ${quoteIdent(t)} ORDER BY ${orderCol} LIMIT ${BATCH} OFFSET ${offset}`,
    );
    if (rows.length === 0) break;

    const valuesSql = [];
    const params = [];
    let p = 1;
    for (const r of rows) {
      const placeholders = colNames.map(() => `$${p++}`);
      valuesSql.push(`(${placeholders.join(", ")})`);
      for (const c of colNames) {
        const v = r[c];
        const meta = cols.rows.find((cc) => cc.column_name === c);
        if (
          meta &&
          (meta.udt_name === "jsonb" || meta.udt_name === "json") &&
          v !== null &&
          typeof v === "object"
        ) {
          params.push(JSON.stringify(v));
        } else {
          params.push(v);
        }
      }
    }
    await target.query(
      `INSERT INTO ${quoteIdent(t)} (${colIdents}) VALUES ${valuesSql.join(", ")}`,
      params,
    );
    total += rows.length;
    if (rows.length < BATCH) break;
    offset += BATCH;
  }
  const ms = Date.now() - t0;
  summary.push({ table: t, rows: total, took_ms: ms });
  console.log(
    `  ✓ ${t.padEnd(28)} ${total.toString().padStart(7)} rows  ${ms}ms`,
  );
}

await live.end();
await target.end();

// ─── 4. Summary ────────────────────────────────────────────────────────
const totalRows = summary.reduce((s, r) => s + (r.rows ?? 0), 0);
const tablesCopied = summary.filter((r) => !r.skipped).length;
console.log(`\n═══ Summary ═══`);
console.log(`  Tables copied:  ${tablesCopied}`);
console.log(`  Total rows:     ${totalRows}`);
console.log(`  Backup DB:      ${BACKUP_DB}`);
console.log(`\nTo inspect:`);
console.log(`  psql ${backupUrl.replace(/:[^:@/]+@/, ":***@")}`);
console.log(`\nTo restore later (writes back to LIVE):`);
console.log(`  Use scripts/restore-from-backup.mjs (build separately).`);

// Seed a fresh, ISOLATED set of stores + recent ad_spend / cogs entries
// for a target tenant on the LOCAL DB so we can test edit-mode without
// touching the Falcon 37 data.
//
// Usage:
//   node --env-file=.env scripts/seed-test-tenant.mjs <tenant-id-or-email>
//
// Defaults: faizanofficial009@gmail.com if no arg passed.
//
// Refuses to run against any non-localhost DATABASE_URL.

import { Client } from "pg";

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
if (!/localhost|127\.0\.0\.1/.test(DB)) {
  console.error("Refusing to run — DATABASE_URL is not local.");
  process.exit(1);
}

const arg = process.argv[2] ?? "faizanofficial009@gmail.com";

const c = new Client({ connectionString: DB });
await c.connect();

// ── Resolve tenant ─────────────────────────────────────────────────────
let tenantId;
let tenantName;
if (/^[0-9a-f-]{36}$/i.test(arg)) {
  const r = await c.query(
    "SELECT id, display_name FROM tenants WHERE id = $1",
    [arg],
  );
  if (r.rows.length === 0) throw new Error("Tenant not found by id");
  tenantId = r.rows[0].id;
  tenantName = r.rows[0].display_name;
} else {
  const r = await c.query(
    "SELECT id, display_name FROM tenants WHERE email = $1 OR display_name ILIKE $1",
    [arg],
  );
  if (r.rows.length === 0) throw new Error(`Tenant not found by '${arg}'`);
  tenantId = r.rows[0].id;
  tenantName = r.rows[0].display_name;
}
console.log(`Seeding tenant: ${tenantName} (${tenantId})\n`);

// ── Stores to create ───────────────────────────────────────────────────
const stores = [
  { id: "NOVA", name: "NOVA USA", currency: "USD", timezone: "America/New_York", processing_fee_pct: 0.029 },
  { id: "NURA", name: "NURA Pro", currency: "USD", timezone: "America/New_York", processing_fee_pct: 0.029 },
  { id: "KOVA", name: "KOVA Care", currency: "USD", timezone: "America/New_York", processing_fee_pct: 0.029 },
  { id: "ELARA", name: "ELARA", currency: "USD", timezone: "America/New_York", processing_fee_pct: 0.029 },
];

for (const s of stores) {
  // stores.id is the global PK. To make the store usable by THIS tenant
  // we upsert with tenant_id reassigned to the requested tenant. This is
  // safe in local dev — production stores live elsewhere.
  const localId = `${s.id}_TEST`;
  await c.query(
    `INSERT INTO stores (id, tenant_id, name, shop_domain, currency, timezone, is_active, processing_fee_pct)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7)
     ON CONFLICT (id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       name = EXCLUDED.name,
       shop_domain = EXCLUDED.shop_domain,
       is_active = true,
       processing_fee_pct = EXCLUDED.processing_fee_pct`,
    [
      localId,
      tenantId,
      s.name + " (test)",
      `${localId.toLowerCase()}.test.myshopify.com`,
      s.currency,
      s.timezone,
      s.processing_fee_pct,
    ],
  );
  console.log(`  ✓ store ${localId} (tenant ${tenantId})`);
}

// ── Sample ad_spend_entries for last 7 days for each test store ────────
const today = new Date();
const days = 7;
let adRows = 0;
let cogsRows = 0;
for (const s of stores) {
  const localId = `${s.id}_TEST`;
  // Delete any pre-existing seeded rows so we start clean.
  await c.query(
    "DELETE FROM ad_spend_entries WHERE tenant_id = $1 AND store_id = $2",
    [tenantId, localId],
  );
  await c.query(
    "DELETE FROM cogs_entries WHERE tenant_id = $1 AND store_id = $2",
    [tenantId, localId],
  );
  for (let i = 0; i < days; i += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const adAmt = 500 + Math.round(Math.random() * 1500);
    const cogsAmt = 200 + Math.round(Math.random() * 800);
    await c.query(
      `INSERT INTO ad_spend_entries (tenant_id, store_id, date, amount, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, 'seed', NOW())`,
      [tenantId, localId, ymd, adAmt],
    );
    await c.query(
      `INSERT INTO cogs_entries (tenant_id, store_id, date, cogs, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, 'seed', NOW())`,
      [tenantId, localId, ymd, cogsAmt],
    );
    adRows += 1;
    cogsRows += 1;
  }
  console.log(`  ✓ ${localId}: ${days} ad_spend + ${days} cogs rows`);
}

console.log(
  `\nSeeded ${stores.length} stores, ${adRows} ad spend entries, ${cogsRows} cogs entries.`,
);
console.log(`\nStore IDs to use in tests:`);
for (const s of stores) console.log(`  - ${s.id}_TEST`);

await c.end();

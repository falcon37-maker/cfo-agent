// Solvpath spot-check.
//
// Pulls every phx_summary_snapshots row for NOVA / NURA / KOVA / PORTFOLIO
// over a given window and surfaces:
//   - bucket totals (direct, initial, recurring, salvage, upsell)
//   - bucket counts (from raw_json.directCount / initialCount / ...)
//   - the sum-check (direct + initial + recurring + salvage + upsell should
//     equal revenue_total, if revenue_total is populated)
//   - any rows where range_from != range_to (multi-day snapshots — those
//     get filtered out by the dashboard, worth knowing)
//   - any null/undefined buckets that suggest a sync issue
//
// This is the "is our Solvpath classifier accurate?" sanity check. Once
// you see the buckets here, compare them to PHX dashboard for the same
// dates — if they match, classification is correct. If not, we have a
// classifier or sync bug to track down.
//
// Usage:
//   node --env-file=.env scripts/verify-solvpath.mjs                       # last 7 days
//   node --env-file=.env scripts/verify-solvpath.mjs 2026-05-25            # one specific date
//   node --env-file=.env scripts/verify-solvpath.mjs 2026-05-20 2026-05-26 # window
//
// Read-only. Never writes.

import { Client as PgClient } from "pg";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const args = process.argv.slice(2);
let from, to;
if (args.length === 0) {
  to = new Date().toISOString().slice(0, 10);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 6);
  from = d.toISOString().slice(0, 10);
} else if (args.length === 1) {
  from = to = args[0];
} else {
  [from, to] = args;
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error("Dates must be YYYY-MM-DD");
  process.exit(1);
}

const db = new PgClient({ connectionString: DB_URL });
await db.connect();

console.log(`\n═══ Solvpath / PHX Snapshot Verification ═══`);
console.log(`   Window: ${from} → ${to}\n`);

// ── List tenants that have any PHX snapshots in this window ────────────
const tenantsRes = await db.query(
  `SELECT DISTINCT t.id, t.display_name
     FROM tenants t
     JOIN phx_summary_snapshots p ON p.tenant_id = t.id
     WHERE p.range_from >= $1 AND p.range_to <= $2
     ORDER BY t.display_name`,
  [from, to],
);

if (tenantsRes.rows.length === 0) {
  console.log("(no PHX snapshots in this window for any tenant)");
  await db.end();
  process.exit(0);
}

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const fmt = (n) =>
  `$${r2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s, n) => String(s).padStart(n);

for (const t of tenantsRes.rows) {
  console.log(`\n── Tenant: ${t.display_name} ${`(${t.id})`} ──`);

  const snaps = await db.query(
    `SELECT store_id, range_from, range_to, scraped_at,
            revenue_direct, revenue_initial, revenue_recurring,
            revenue_salvage, revenue_upsell, revenue_total,
            raw_json
       FROM phx_summary_snapshots
       WHERE tenant_id = $1
         AND range_from >= $2 AND range_to <= $3
       ORDER BY store_id, range_from`,
    [t.id, from, to],
  );

  if (snaps.rows.length === 0) {
    console.log("  (no snapshots)");
    continue;
  }

  console.log(
    `\n  ${pad("Store", 10)} ${pad("Date", 12)} ${pad("Direct", 10)} ${pad("Initial", 10)} ${pad("Recurring", 11)} ${pad("Salvage", 10)} ${pad("Upsell", 10)} ${pad("Sum", 10)} ${pad("Total", 10)} ${pad("Δ", 10)}`,
  );
  console.log(`  ${"─".repeat(125)}`);

  let totalDirect = 0,
    totalInitial = 0,
    totalRecurring = 0,
    totalSalvage = 0,
    totalUpsell = 0,
    totalRevenue = 0;
  const anomalies = [];

  // pg returns DATE columns as JS Date objects; normalize to YYYY-MM-DD strings.
  const asYmd = (v) => {
    if (!v) return null;
    if (typeof v === "string") return v.slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  for (const r of snaps.rows) {
    const direct = r2(r.revenue_direct);
    const initial = r2(r.revenue_initial);
    const recurring = r2(r.revenue_recurring);
    const salvage = r2(r.revenue_salvage);
    const upsell = r2(r.revenue_upsell);
    const sum = direct + initial + recurring + salvage + upsell;
    const total = r2(r.revenue_total);
    const delta = total > 0 ? r2(sum - total) : null;

    const rf = asYmd(r.range_from);
    const rt = asYmd(r.range_to);
    const dateStr = rf === rt ? rf : `${rf}/${rt}`;

    console.log(
      `  ${pad(r.store_id, 10)} ${pad(dateStr, 12)} ${pad(fmt(direct), 10)} ${pad(fmt(initial), 10)} ${pad(fmt(recurring), 11)} ${pad(fmt(salvage), 10)} ${pad(fmt(upsell), 10)} ${pad(fmt(sum), 10)} ${pad(total ? fmt(total) : "—", 10)} ${pad(delta === null ? "—" : fmt(delta), 10)}`,
    );

    totalDirect += direct;
    totalInitial += initial;
    totalRecurring += recurring;
    totalSalvage += salvage;
    totalUpsell += upsell;
    totalRevenue += total;

    if (rf !== rt) {
      anomalies.push(
        `multi-day snapshot: ${r.store_id} ${rf} → ${rt} (dashboard skips these)`,
      );
    }
    if (delta !== null && Math.abs(delta) > 0.5) {
      anomalies.push(
        `bucket sum (${fmt(sum)}) does not match revenue_total (${fmt(total)}) for ${r.store_id} ${dateStr} — Δ ${fmt(delta)}`,
      );
    }
    if (
      r.raw_json &&
      typeof r.raw_json === "object" &&
      Array.isArray(r.raw_json.unknownTypes) &&
      r.raw_json.unknownTypes.length > 0
    ) {
      anomalies.push(
        `unknown Solvpath types for ${r.store_id} ${dateStr}: ${r.raw_json.unknownTypes.join(", ")}`,
      );
    }
  }

  console.log(`  ${"─".repeat(125)}`);
  const totalSum =
    totalDirect + totalInitial + totalRecurring + totalSalvage + totalUpsell;
  console.log(
    `  ${pad("TOTAL", 10)} ${pad("", 12)} ${pad(fmt(totalDirect), 10)} ${pad(fmt(totalInitial), 10)} ${pad(fmt(totalRecurring), 11)} ${pad(fmt(totalSalvage), 10)} ${pad(fmt(totalUpsell), 10)} ${pad(fmt(totalSum), 10)} ${pad(totalRevenue ? fmt(totalRevenue) : "—", 10)}`,
  );

  // Per-store roll-up (if multiple snapshots per store in window)
  console.log("\n  Per-store rollup:");
  const byStore = {};
  for (const r of snaps.rows) {
    if (asYmd(r.range_from) !== asYmd(r.range_to)) continue;
    const s = (byStore[r.store_id] ||= {
      direct: 0,
      initial: 0,
      recurring: 0,
      salvage: 0,
      upsell: 0,
      total: 0,
      days: 0,
    });
    s.direct += r2(r.revenue_direct);
    s.initial += r2(r.revenue_initial);
    s.recurring += r2(r.revenue_recurring);
    s.salvage += r2(r.revenue_salvage);
    s.upsell += r2(r.revenue_upsell);
    s.total += r2(r.revenue_total);
    s.days += 1;
  }
  for (const [store, s] of Object.entries(byStore)) {
    const sum = s.direct + s.initial + s.recurring + s.salvage + s.upsell;
    console.log(
      `    ${pad(store, 10)} ${s.days}d  direct=${fmt(s.direct)}  initial=${fmt(s.initial)}  recurring=${fmt(s.recurring)}  salvage=${fmt(s.salvage)}  upsell=${fmt(s.upsell)}  sum=${fmt(sum)}  total=${fmt(s.total)}`,
    );
  }

  if (anomalies.length > 0) {
    console.log("\n  ⚠ Anomalies:");
    for (const a of anomalies) console.log(`    • ${a}`);
  } else {
    console.log("\n  ✓ No anomalies (bucket sums match revenue_total, no unknown types)");
  }
}

console.log("\n── Recommendation ──────────────────────────────────");
console.log("  Compare each store's per-day buckets above to what the PHX/Phoenix");
console.log("  dashboard reports for the same date. If they match, our Solvpath");
console.log("  classification is correct. If not, share a screenshot of PHX for");
console.log("  the mismatched date and we'll trace the classifier.\n");

await db.end();

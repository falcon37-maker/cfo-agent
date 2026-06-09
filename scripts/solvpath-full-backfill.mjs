// Phase 2 — Solvpath full backfill.
//
// Purpose: process EVERY active subscriber for a given date range so that
// recurring revenue is captured correctly. The daily cron only processes
// ~500 customers per fire (deadline + Vercel limit), so out of ~3,442
// active subscribers we miss ~85% per day — which is why recurring revenue
// has been showing $0 on the dashboard.
//
// This script calls /api/sync/solvpath?action=backfill repeatedly with the
// same date, advancing the (startStatus, startPage) cursor each call, until
// `finished: true`. No time pressure — runs locally, can take 30+ minutes
// per day if needed.
//
// Usage:
//   node --env-file=.env scripts/solvpath-full-backfill.mjs <FROM_DATE> <TO_DATE> [tenantId]
//
// Examples:
//   # Backfill May 1-7 for the only active tenant
//   node --env-file=.env scripts/solvpath-full-backfill.mjs 2026-05-01 2026-05-07
//
//   # Specific tenant, one day
//   node --env-file=.env scripts/solvpath-full-backfill.mjs 2026-05-25 2026-05-25 116dc838-df19-44ba-9b93-92ab7be371a8
//
//   # Wipe existing snapshots for the range first, then rebuild
//   RESET=1 node --env-file=.env scripts/solvpath-full-backfill.mjs 2026-05-01 2026-05-07

const BASE = process.env.BACKFILL_BASE_URL || "http://localhost:3001";
const SECRET = process.env.CRON_SECRET;
if (!SECRET) {
  console.error("Missing CRON_SECRET in env");
  process.exit(1);
}

const args = process.argv.slice(2);
const [FROM, TO, TENANT_ID] = args;
if (!FROM || !TO || !/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error(
    "Usage: node --env-file=.env scripts/solvpath-full-backfill.mjs <FROM> <TO> [tenantId]",
  );
  process.exit(1);
}

const RESET = process.env.RESET === "1";
console.log(`\n═══ Solvpath Full Backfill ═══`);
console.log(`   Range:  ${FROM} → ${TO}`);
console.log(`   Reset:  ${RESET ? "YES (wipes existing snapshots)" : "no"}`);
console.log(`   Tenant: ${TENANT_ID || "(auto)"}`);
console.log("");

// Iterate each day in the range so each gets its own dedupe state.
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86400000);
}

const totalDays = diffDays(FROM, TO) + 1;
console.log(`Days to process: ${totalDays}\n`);

const runStarted = Date.now();
let day = FROM;
let dayCount = 0;
const allResults = [];

while (day <= TO) {
  dayCount += 1;
  console.log(`── Day ${dayCount}/${totalDays}: ${day} ──`);

  // First chunk: optional reset, no startStatus / startPage cursor.
  let startStatus = null;
  let startPage = null;
  let chunkNum = 0;
  let totalCustomers = 0;
  let totalWithTx = 0;
  let totalElapsed = 0;
  let finished = false;

  while (!finished) {
    chunkNum += 1;
    const params = new URLSearchParams({
      action: "backfill",
      from: day,
      to: day,
      secret: SECRET,
    });
    if (TENANT_ID) params.set("tenantId", TENANT_ID);
    if (RESET && chunkNum === 1) params.set("reset", "1");
    if (startStatus) params.set("startStatus", startStatus);
    if (startPage) params.set("startPage", String(startPage));

    const url = `${BASE}/api/sync/solvpath?${params.toString()}`;
    const chunkStart = Date.now();
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      console.error(`  ✗ chunk ${chunkNum}: network error: ${e.message}`);
      // Backoff and retry once.
      await new Promise((r) => setTimeout(r, 5000));
      try {
        resp = await fetch(url);
      } catch (e2) {
        console.error(`  ✗ chunk ${chunkNum} retry failed: ${e2.message}`);
        process.exit(1);
      }
    }
    const elapsed = Date.now() - chunkStart;
    totalElapsed += elapsed;

    if (!resp.ok) {
      const txt = await resp.text();
      console.error(`  ✗ chunk ${chunkNum} HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      process.exit(1);
    }

    const json = await resp.json();
    const p = json.result?.progress;
    if (!p) {
      console.error(`  ✗ chunk ${chunkNum}: no progress in response`, json);
      process.exit(1);
    }

    totalCustomers += p.customersSeen;
    totalWithTx += p.customersWithTx;
    console.log(
      `  chunk ${String(chunkNum).padStart(2)}: ${String(p.customersSeen).padStart(4)} customers (${p.customersWithTx} with tx) in ${(elapsed / 1000).toFixed(1)}s  ${p.finished ? "✓ finished" : `→ next: ${p.nextStatus}/p${p.nextPage}`}`,
    );

    if (p.finished) {
      finished = true;
      break;
    }
    if (p.nextStatus == null || p.nextPage == null) {
      console.log(`  ⚠ no cursor advance but not finished — stopping day to avoid loop`);
      break;
    }
    startStatus = p.nextStatus;
    startPage = p.nextPage;

    // Brief pause between chunks to be friendly to Solvpath API.
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `  → day ${day}: ${chunkNum} chunks, ${totalCustomers} customers, ${(totalElapsed / 1000).toFixed(1)}s ${finished ? "✓" : "⚠ incomplete"}`,
  );
  allResults.push({
    day,
    chunks: chunkNum,
    customers: totalCustomers,
    withTx: totalWithTx,
    elapsedSec: Math.round(totalElapsed / 1000),
    finished,
  });
  console.log("");

  day = addDays(day, 1);
}

const runElapsed = Math.round((Date.now() - runStarted) / 1000);
console.log(`═══ Backfill complete in ${Math.floor(runElapsed / 60)}m ${runElapsed % 60}s ═══`);
console.log("\nPer-day summary:");
console.table(allResults);

const incomplete = allResults.filter((r) => !r.finished);
if (incomplete.length > 0) {
  console.log(`\n⚠ ${incomplete.length} day(s) did not finish — re-run with those dates.`);
  process.exit(1);
}
console.log("\n✓ All days finished. Run scripts/verify-solvpath.mjs to confirm bucket totals.");

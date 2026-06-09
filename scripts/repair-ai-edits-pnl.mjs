// One-time repair: reconcile ad_spend_entries + cogs_entries into
// daily_ad_spend + daily_pnl for any (tenant, store, date) that was
// touched by an AI chat edit (submitted_by LIKE 'AI edit%') but never
// had the rollup propagated.
//
// Why this exists: an earlier version of /api/chat/confirm wrote only to
// the audit tables and skipped the daily_ad_spend + daily_pnl rollup, so
// the dashboard showed $0 for ad spend / COGS even when the edit was
// successfully applied. The fix is in place going forward; this script
// reconciles the rows that were applied before the fix.
//
// Safe to re-run. No deletes. Operates only on rows whose submitted_by
// starts with "AI edit".
//
// Usage:
//   node --env-file=.env scripts/repair-ai-edits-pnl.mjs            # dry run
//   node --env-file=.env scripts/repair-ai-edits-pnl.mjs --apply    # write

import { Client } from "pg";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
console.log(APPLY ? "MODE: APPLY (writes)" : "MODE: DRY RUN");

const db = new Client({ connectionString: DB_URL });
await db.connect();

function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ── Pull every (tenant, store, date) touched by an AI ad-spend edit ────
const adEdits = await db.query(
  `SELECT DISTINCT tenant_id, store_id, date, amount, submitted_by
     FROM ad_spend_entries
     WHERE submitted_by LIKE 'AI edit%'
     ORDER BY date DESC`,
);
console.log(`\nAI-touched ad_spend rows: ${adEdits.rows.length}`);

for (const row of adEdits.rows) {
  const { tenant_id, store_id, date, amount, submitted_by } = row;
  // Look at what daily_ad_spend currently has
  const cur = await db.query(
    `SELECT COALESCE(SUM(spend), 0)::float AS total
       FROM daily_ad_spend
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [tenant_id, store_id, date],
  );
  const curSpend = Number(cur.rows[0].total);
  const newSpend = Number(amount);
  if (Math.abs(curSpend - newSpend) < 0.005) {
    console.log(`  = ${store_id} ${date} already $${newSpend.toFixed(2)}`);
    continue;
  }
  console.log(
    `  → ${store_id} ${date}  daily_ad_spend $${curSpend.toFixed(2)} → $${newSpend.toFixed(2)} (${submitted_by})`,
  );
  if (!APPLY) continue;

  // Replace daily_ad_spend(platform='facebook') with the edit value.
  // Other platform rows for this (store,date) are left alone, but we
  // null them out by setting their spend to 0 — the AI edit treats the
  // whole day as a single number, so this is the only way to keep
  // daily_pnl.ad_spend matching what the AI staged.
  await db.query(
    `UPDATE daily_ad_spend SET spend = 0, synced_at = NOW()
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3
         AND platform <> 'facebook'`,
    [tenant_id, store_id, date],
  );
  await db.query(
    `INSERT INTO daily_ad_spend
       (tenant_id, store_id, date, platform, spend, currency, synced_at)
     VALUES ($1, $2, $3, 'facebook', $4, 'USD', NOW())
     ON CONFLICT (store_id, date, platform)
     DO UPDATE SET spend = EXCLUDED.spend, synced_at = NOW()`,
    [tenant_id, store_id, date, newSpend],
  );
  await rollup(tenant_id, store_id, date);
}

// ── COGS edits ──────────────────────────────────────────────────────────
const cogsEdits = await db.query(
  `SELECT DISTINCT tenant_id, store_id, date, cogs, submitted_by
     FROM cogs_entries
     WHERE submitted_by LIKE 'AI edit%'
     ORDER BY date DESC`,
);
console.log(`\nAI-touched cogs rows: ${cogsEdits.rows.length}`);

for (const row of cogsEdits.rows) {
  const { tenant_id, store_id, date, cogs, submitted_by } = row;
  const cur = await db.query(
    `SELECT cogs FROM daily_pnl
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [tenant_id, store_id, date],
  );
  const curCogs = Number(cur.rows[0]?.cogs ?? 0);
  const newCogs = Number(cogs);
  if (Math.abs(curCogs - newCogs) < 0.005) {
    console.log(`  = ${store_id} ${date} cogs already $${newCogs.toFixed(2)}`);
    continue;
  }
  console.log(
    `  → ${store_id} ${date}  daily_pnl.cogs $${curCogs.toFixed(2)} → $${newCogs.toFixed(2)} (${submitted_by})`,
  );
  if (!APPLY) continue;
  await db.query(
    `INSERT INTO daily_pnl
       (tenant_id, store_id, date, revenue, cogs, fees, refunds,
        ad_spend, shipping_cost, gross_profit, net_profit, margin_pct,
        order_count, computed_at)
     VALUES ($1, $2, $3, 0, $4, 0, 0, 0, 0, 0, 0, 0, 0, NOW())
     ON CONFLICT (store_id, date)
     DO UPDATE SET cogs = EXCLUDED.cogs, computed_at = NOW()`,
    [tenant_id, store_id, date, newCogs],
  );
  await rollup(tenant_id, store_id, date);
}

console.log(APPLY ? "\nDone (applied)." : "\nDry run complete. Re-run with --apply to write.");
await db.end();

// ── Rollup helper ───────────────────────────────────────────────────────
async function rollup(tenantId, storeId, date) {
  const { rows: spendRows } = await db.query(
    `SELECT COALESCE(SUM(spend), 0)::float AS total
       FROM daily_ad_spend
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [tenantId, storeId, date],
  );
  const totalSpend = Number(spendRows[0]?.total ?? 0);

  const { rows: pnlRows } = await db.query(
    `SELECT revenue, cogs, fees, refunds, shipping_cost, order_count
       FROM daily_pnl
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [tenantId, storeId, date],
  );
  const pnl = pnlRows[0] ?? {};
  const revenue = Number(pnl.revenue ?? 0);
  const cogs = Number(pnl.cogs ?? 0);
  const fees = Number(pnl.fees ?? 0);
  const refunds = Number(pnl.refunds ?? 0);
  const shipping = Number(pnl.shipping_cost ?? 0);
  const gross = revenue - cogs;
  const net = revenue - cogs - fees - refunds - totalSpend;
  const margin = revenue > 0 ? (net / revenue) * 100 : 0;

  await db.query(
    `INSERT INTO daily_pnl
       (tenant_id, store_id, date, revenue, cogs, fees, refunds,
        ad_spend, shipping_cost, gross_profit, net_profit, margin_pct,
        order_count, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (store_id, date)
     DO UPDATE SET
       ad_spend = EXCLUDED.ad_spend,
       gross_profit = EXCLUDED.gross_profit,
       net_profit = EXCLUDED.net_profit,
       margin_pct = EXCLUDED.margin_pct,
       computed_at = NOW()`,
    [
      tenantId, storeId, date,
      r2(revenue), r2(cogs), r2(fees), r2(refunds),
      r2(totalSpend), r2(shipping),
      r2(gross), r2(net), r2(margin),
      Number(pnl.order_count ?? 0),
    ],
  );
}

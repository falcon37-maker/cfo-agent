// Fee-rate realignment + confirmed ad-spend repairs for tenant Falcon 37 LLC.
//   node --env-file=.env tmp-fix-fees.mjs                    → dry run
//   node --env-file=.env tmp-fix-fees.mjs --apply --backup X  → write, backup to X
//
// Rules (client spec Jun 2026, mirrors src/lib/pnl/fees.ts):
//   NOVA / NURA / KOVA → 16.3%     everyone else → 3.9%
//   fees = revenue × rate ; net_profit = revenue − cogs − fees − ad_spend
//
// Ad-spend repairs are an explicit allowlist, NOT "recompute from entries".
// Only these two cells lost data to the "latest entry wins" bug in
// recomputeAdSpendFor (KOVA runs two ad accounts daily — both entries are real,
// the rollup kept only the later one). Deliberately NOT touched:
//   · NOVA 2026-06-21 — two identical $919.70 entries 1s apart (double-click);
//     the rollup's single 919.70 is correct, the audit log has the phantom.
//   · 6 duplicate `Meta` platform rows (Apr–May) that double-count a same-day
//     `facebook` row — deleting financial records needs an explicit decision.
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const BACKUP = process.argv[process.argv.indexOf("--backup") + 1] ?? "./backup.json";
const TENANT = "116dc838-df19-44ba-9b93-92ab7be371a8";
const SUBS = new Set(["NOVA", "NURA", "KOVA"]);
const rate = (id) => (SUBS.has(id) ? 0.163 : 0.039);
const r2 = (n) => Math.round(n * 100) / 100;

const AD_REPAIRS = [
  { store: "KOVA", date: "2026-07-12", spend: 5618.08 }, // 2487.98 + 3130.10
  { store: "KOVA", date: "2026-07-29", spend: 3117.76 }, // 2573.06 +  544.70
];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Supabase caps a select at 1000 rows — page through everything. */
async function selectAll(table, columns) {
  const out = [];
  const size = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .eq("tenant_id", TENANT)
      .order("date")
      .order("store_id")
      .range(page * size, page * size + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < size) return out;
  }
}

const pnlRows = await selectAll(
  "daily_pnl",
  "store_id, date, revenue, cogs, fees, refunds, ad_spend, gross_profit, net_profit, margin_pct",
);
const adRows = await selectAll("daily_ad_spend", "store_id, date, platform, spend");
console.log(`Loaded ${pnlRows.length} daily_pnl rows, ${adRows.length} daily_ad_spend rows.`);

// ── daily_pnl: recompute fees / net, applying the ad-spend repairs ──────────
const repairOf = (s, d) => AD_REPAIRS.find((f) => f.store === s && f.date === d);
// 2026 onwards only. The 2025 rows (NOVA/NURA, Jul–Dec) carry fees at exactly
// 3.00% from an older import — the 16.3% spec dates from Jun 2026, and applying
// it retroactively would restate 2025 by −$148,570.51. That's the client's call,
// so those rows are left alone until they answer.
const FROM_DATE = "2026-01-01";
const pnlFixes = [];
for (const r of pnlRows) {
  if (r.date < FROM_DATE) continue;
  const revenue = Number(r.revenue ?? 0);
  const cogs = Number(r.cogs ?? 0);
  const rep = repairOf(r.store_id, r.date);
  const adSpend = rep ? rep.spend : Number(r.ad_spend ?? 0);
  const fees = r2(revenue * rate(r.store_id));
  const grossProfit = r2(revenue - cogs);
  const netProfit = r2(revenue - cogs - fees - adSpend);
  const marginPct = revenue > 0 ? r2((netProfit / revenue) * 100) : 0;
  const changed =
    Math.abs(fees - Number(r.fees ?? 0)) > 0.005 ||
    Math.abs(netProfit - Number(r.net_profit ?? 0)) > 0.005 ||
    Math.abs(adSpend - Number(r.ad_spend ?? 0)) > 0.005 ||
    Math.abs(grossProfit - Number(r.gross_profit ?? 0)) > 0.005;
  if (changed) {
    pnlFixes.push({
      store_id: r.store_id, date: r.date,
      fees, ad_spend: adSpend, gross_profit: grossProfit,
      net_profit: netProfit, margin_pct: marginPct,
      _oldNet: Number(r.net_profit ?? 0),
    });
  }
}
const netDelta = pnlFixes.reduce((s, f) => s + (f.net_profit - f._oldNet), 0);
const dates = pnlRows.map((r) => r.date).sort();
console.log(
  `daily_pnl: ${pnlFixes.length} of ${pnlRows.length} rows change ` +
    `(${dates[0]} → ${dates[dates.length - 1]}), net profit delta ${netDelta.toFixed(2)}`,
);

// ── stores.processing_fee_pct ───────────────────────────────────────────────
const { data: stores } = await sb
  .from("stores").select("id, processing_fee_pct")
  .eq("tenant_id", TENANT).eq("is_active", true).order("id");
const storeFixes = (stores ?? [])
  .filter((s) => Math.abs(Number(s.processing_fee_pct) - rate(s.id)) > 1e-9)
  .map((s) => ({ id: s.id, from: Number(s.processing_fee_pct), to: rate(s.id) }));
for (const s of storeFixes) {
  console.log(`stores: ${s.id.padEnd(10)} ${(s.from * 100).toFixed(2)}% -> ${(s.to * 100).toFixed(2)}%`);
}
for (const f of AD_REPAIRS) console.log(`ad_spend repair: ${f.date} ${f.store} -> ${f.spend.toFixed(2)}`);

if (!APPLY) {
  console.log("\n(dry run — nothing written)");
  process.exit(0);
}

// ── Backup, then write ──────────────────────────────────────────────────────
writeFileSync(
  BACKUP,
  JSON.stringify({ tenant: TENANT, note: "pre fee-realignment snapshot", stores, daily_pnl: pnlRows, daily_ad_spend: adRows }, null, 2),
);
console.log(`\nBackup written: ${BACKUP}`);

for (const f of AD_REPAIRS) {
  const { error } = await sb.from("daily_ad_spend").upsert(
    { tenant_id: TENANT, store_id: f.store, date: f.date, platform: "facebook", spend: f.spend, currency: "USD" },
    { onConflict: "store_id,date,platform" },
  );
  if (error) throw new Error(`daily_ad_spend ${f.store} ${f.date}: ${error.message}`);
}
console.log(`daily_ad_spend: ${AD_REPAIRS.length} cell(s) repaired`);

let done = 0;
for (const f of pnlFixes) {
  const { error } = await sb.from("daily_pnl")
    .update({
      fees: f.fees, ad_spend: f.ad_spend, gross_profit: f.gross_profit,
      net_profit: f.net_profit, margin_pct: f.margin_pct,
    })
    .eq("tenant_id", TENANT).eq("store_id", f.store_id).eq("date", f.date);
  if (error) throw new Error(`daily_pnl ${f.store_id} ${f.date}: ${error.message}`);
  done++;
}
console.log(`daily_pnl: ${done} row(s) updated`);

for (const s of storeFixes) {
  const { error } = await sb.from("stores")
    .update({ processing_fee_pct: s.to })
    .eq("tenant_id", TENANT).eq("id", s.id);
  if (error) throw new Error(`stores ${s.id}: ${error.message}`);
}
console.log(`stores: ${storeFixes.length} rate(s) updated`);
console.log("\nDONE");

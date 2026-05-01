// Verify what's actually in `scrape_date` vs `range_from` columns.
// Hypothesis: scrape_date is "when the scrape ran" (today), range_from is "what
// date the data is for". The dashboard reads range_from. The user's audit query
// grouped on scrape_date and saw 1 distinct date — that's expected, not corrupt.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";

// Total rows
const { count: total } = await sb.from("phx_summary_snapshots")
  .select("*", { count: "exact", head: true }).eq("tenant_id", T);
console.log(`Total rows for tenant: ${total}`);

// Distinct scrape_dates
const { data: bySD } = await sb.from("phx_summary_snapshots")
  .select("scrape_date").eq("tenant_id", T);
const sdSet = new Set(bySD.map(r => r.scrape_date));
console.log(`Distinct scrape_date values: ${sdSet.size} → ${[...sdSet].sort().join(", ")}`);

// Distinct range_from
const { data: byRF } = await sb.from("phx_summary_snapshots")
  .select("range_from, range_to, store_id").eq("tenant_id", T);
const rfSet = new Set(byRF.filter(r => r.range_from === r.range_to).map(r => r.range_from));
console.log(`\nDistinct range_from (per-day rows only): ${rfSet.size}`);
console.log(`  Earliest: ${[...rfSet].sort()[0]}`);
console.log(`  Latest:   ${[...rfSet].sort().slice(-1)[0]}`);

// User's exact query — group by (scrape_date, store_id)
const { data: userQuery } = await sb.from("phx_summary_snapshots")
  .select("scrape_date, store_id").eq("tenant_id", T);
const groupSD = new Map();
for (const r of userQuery) {
  const k = `${r.scrape_date}|${r.store_id}`;
  groupSD.set(k, (groupSD.get(k) ?? 0) + 1);
}
console.log("\n=== User's audit (group by scrape_date, store_id) ===");
console.table([...groupSD.entries()].map(([k,c]) => ({ key: k, count: c })));

// Correct query — group by (range_from, store_id) for per-day rows
const groupRF = new Map();
for (const r of byRF) {
  if (r.range_from !== r.range_to) continue;
  if (!["NOVA","NURA","KOVA"].includes(r.store_id)) continue;
  const k = `${r.range_from}|${r.store_id}`;
  groupRF.set(k, (groupRF.get(k) ?? 0) + 1);
}
const dups = [...groupRF.entries()].filter(([_, c]) => c > 1);
console.log(`\n=== Correct query (group by range_from, store_id) ===`);
console.log(`Total distinct (date, store) pairs: ${groupRF.size}`);
console.log(`Duplicates (count > 1): ${dups.length}`);

// Sample data — show actual revenue per range_from for Apr 1-5
const { data: sample } = await sb.from("phx_summary_snapshots")
  .select("range_from, range_to, store_id, scrape_date, revenue_initial, revenue_recurring, revenue_total")
  .eq("tenant_id", T)
  .gte("range_from", "2026-04-01")
  .lte("range_from", "2026-04-05")
  .order("range_from")
  .order("store_id");
console.log("\n=== Sample: Apr 1-5 rows (showing range_from = data date, scrape_date = scrape time) ===");
console.table(sample.map(r => ({
  range_from: r.range_from,
  scrape_date: r.scrape_date,
  store: r.store_id,
  init: r.revenue_initial,
  recur: r.revenue_recurring,
  total: r.revenue_total,
  perDay: r.range_from === r.range_to ? "Y" : "N",
})));

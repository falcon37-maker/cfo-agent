// Re-run the audit query the user proposed to confirm scrape_date now reads
// like a per-day data column.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";

// First-page audit (the SELECT the user wrote)
const { data: firstRows } = await sb
  .from("phx_summary_snapshots")
  .select("scrape_date, store_id, revenue_initial, revenue_recurring")
  .eq("tenant_id", T)
  .in("store_id", ["NOVA","NURA","KOVA"])
  .order("scrape_date")
  .order("store_id")
  .limit(20);
console.log("=== First 20 rows (user's verify query) ===");
console.table(firstRows);

// Group counts by (scrape_date, store_id)
const { data: all } = await sb
  .from("phx_summary_snapshots")
  .select("scrape_date, store_id")
  .eq("tenant_id", T)
  .in("store_id", ["NOVA","NURA","KOVA"]);
const counts = new Map();
for (const r of all) {
  const k = `${r.scrape_date}|${r.store_id}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
const dups = [...counts.entries()].filter(([_, c]) => c > 1);
console.log(`\nDistinct (scrape_date, store_id) pairs: ${counts.size}`);
console.log(`Duplicates (count > 1): ${dups.length}`);

// Compare Apr 1-29 vs Apr 30 totals (the spike test)
const { data: apr30 } = await sb
  .from("phx_summary_snapshots")
  .select("revenue_total")
  .eq("tenant_id", T)
  .eq("scrape_date", "2026-04-30")
  .in("store_id", ["NOVA","NURA","KOVA"]);
const apr30Sum = apr30.reduce((s, r) => s + Number(r.revenue_total ?? 0), 0);

const { data: apr1to29 } = await sb
  .from("phx_summary_snapshots")
  .select("revenue_total")
  .eq("tenant_id", T)
  .gte("scrape_date", "2026-04-01")
  .lte("scrape_date", "2026-04-29")
  .in("store_id", ["NOVA","NURA","KOVA"]);
const apr29Sum = apr1to29.reduce((s, r) => s + Number(r.revenue_total ?? 0), 0);

console.log(`\nApr 30 total (was: $29k+, all data piled here):  $${apr30Sum.toFixed(2)}`);
console.log(`Apr 1-29 total (was: $0, no rows):                $${apr29Sum.toFixed(2)}`);

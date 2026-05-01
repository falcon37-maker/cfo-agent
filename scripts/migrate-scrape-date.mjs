// One-shot: set scrape_date = range_from for every phx_summary_snapshots
// row in Joseph's tenant. After this, audits that GROUP BY scrape_date show
// real data dates instead of "whichever day the backfill ran".
//
// scraped_at (timestamp) keeps the original wall-clock write time, so we
// don't lose the "when" signal.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";

const { data: rows, error: readErr } = await sb
  .from("phx_summary_snapshots")
  .select("id, store_id, range_from, range_to, scrape_date")
  .eq("tenant_id", T);
if (readErr) throw readErr;
console.log(`Total rows: ${rows.length}`);

const needsUpdate = rows.filter((r) => r.scrape_date !== r.range_from);
console.log(`Rows where scrape_date != range_from: ${needsUpdate.length}`);

let done = 0;
for (const r of needsUpdate) {
  const { error } = await sb
    .from("phx_summary_snapshots")
    .update({ scrape_date: r.range_from })
    .eq("id", r.id);
  if (error) {
    console.error(`Failed id=${r.id}:`, error.message);
    continue;
  }
  done += 1;
  if (done % 50 === 0) console.log(`  ${done}/${needsUpdate.length}`);
}
console.log(`Updated: ${done}/${needsUpdate.length}`);

// Verify
const { data: verify } = await sb
  .from("phx_summary_snapshots")
  .select("scrape_date")
  .eq("tenant_id", T);
const distinct = new Set(verify.map((r) => r.scrape_date));
console.log(`\nDistinct scrape_date after migrate: ${distinct.size}`);
console.log(`Earliest: ${[...distinct].sort()[0]}`);
console.log(`Latest:   ${[...distinct].sort().slice(-1)[0]}`);

// Cross-check: scrape_date should now match range_from on every per-day row
const { data: mismatch } = await sb
  .from("phx_summary_snapshots")
  .select("id, store_id, range_from, scrape_date")
  .eq("tenant_id", T)
  .neq("scrape_date", "range_from");
// (this neq won't work as col-to-col compare; we'll verify in JS)
const { data: all2 } = await sb
  .from("phx_summary_snapshots")
  .select("id, store_id, range_from, scrape_date")
  .eq("tenant_id", T);
const stillMismatch = all2.filter((r) => r.scrape_date !== r.range_from);
console.log(`Rows still mismatching: ${stillMismatch.length}`);
if (stillMismatch.length) console.table(stillMismatch.slice(0, 10));

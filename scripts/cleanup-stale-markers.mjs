// Delete stale dedupe / PORTFOLIO marker rows.
// Keep the fresh 2026-04-01..2026-04-30 dedupe marker (active state).
// Drop:
//   - period __BACKFILL_DEDUPE__ rows for Jan, Feb, Mar, Apr 1-23
//   - per-day __BACKFILL_DEDUPE__ rows for Apr 24-29
//   - PORTFOLIO Apr 1-23 row (legacy)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TENANT = "116dc838-df19-44ba-9b93-92ab7be371a8";
const KEEP_FROM = "2026-04-01";
const KEEP_TO = "2026-04-30";

// Step A: list everything matching DEDUPE/PORTFOLIO
const { data: candidates, error: readErr } = await sb
  .from("phx_summary_snapshots")
  .select("id, store_id, range_from, range_to, scrape_date")
  .eq("tenant_id", TENANT)
  .in("store_id", ["__BACKFILL_DEDUPE__", "PORTFOLIO"]);
if (readErr) throw readErr;

console.log(`Candidates: ${candidates.length}`);
console.table(candidates.map((r) => ({ id: r.id, store: r.store_id, from: r.range_from, to: r.range_to })));

const toDelete = candidates.filter((r) => {
  // Always delete PORTFOLIO rows (legacy multi-day rollups, NULL revenue)
  if (r.store_id === "PORTFOLIO") return true;
  // Keep the fresh Apr 1-30 dedupe marker
  if (r.range_from === KEEP_FROM && r.range_to === KEEP_TO) return false;
  return true;
});

console.log(`\nDeleting ${toDelete.length}, keeping ${candidates.length - toDelete.length}`);

if (toDelete.length === 0) {
  console.log("nothing to do");
  process.exit(0);
}

const ids = toDelete.map((r) => r.id);
const { error: delErr } = await sb
  .from("phx_summary_snapshots")
  .delete()
  .in("id", ids);
if (delErr) throw delErr;

console.log("deleted ✓");

// Verify
const { data: leftover } = await sb
  .from("phx_summary_snapshots")
  .select("store_id, range_from, range_to")
  .eq("tenant_id", TENANT)
  .in("store_id", ["__BACKFILL_DEDUPE__", "PORTFOLIO"]);
console.log(`\nRemaining: ${leftover?.length ?? 0}`);
if (leftover?.length) console.table(leftover);

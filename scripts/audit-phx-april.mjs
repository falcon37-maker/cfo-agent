// Step 4 verification: confirm April rows look daily, init is non-zero,
// no duplicates, no PORTFOLIO/dedupe leakage.
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

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const TENANT = "116dc838-df19-44ba-9b93-92ab7be371a8";

const { data } = await sb
  .from("phx_summary_snapshots")
  .select(
    "store_id, range_from, range_to, revenue_initial, revenue_recurring, revenue_salvage, revenue_direct, revenue_upsell, revenue_total, raw_json",
  )
  .eq("tenant_id", TENANT)
  .gte("range_from", "2026-04-01")
  .lte("range_from", "2026-04-30")
  .order("range_from")
  .order("store_id");

const real = data.filter(
  (r) => r.range_from === r.range_to && ["NOVA", "NURA", "KOVA"].includes(r.store_id),
);

console.log("=== April per-day rows ===");
console.table(
  real.map((r) => ({
    date: r.range_from,
    store: r.store_id,
    init: Number(r.revenue_initial ?? 0).toFixed(2),
    recur: Number(r.revenue_recurring ?? 0).toFixed(2),
    salv: Number(r.revenue_salvage ?? 0).toFixed(2),
    direct: Number(r.revenue_direct ?? 0).toFixed(2),
    total: Number(r.revenue_total ?? 0).toFixed(2),
  })),
);

const totals = { NOVA: 0, NURA: 0, KOVA: 0 };
const initTotals = { NOVA: 0, NURA: 0, KOVA: 0 };
const directTotals = { NOVA: 0, NURA: 0, KOVA: 0 };
const recurTotals = { NOVA: 0, NURA: 0, KOVA: 0 };
for (const r of real) {
  totals[r.store_id] += Number(r.revenue_total ?? 0);
  initTotals[r.store_id] += Number(r.revenue_initial ?? 0);
  directTotals[r.store_id] += Number(r.revenue_direct ?? 0);
  recurTotals[r.store_id] += Number(r.revenue_recurring ?? 0);
}
console.log("\n=== April subtotals ===");
console.table(
  ["NOVA", "NURA", "KOVA"].map((s) => ({
    store: s,
    init: initTotals[s].toFixed(2),
    recur: recurTotals[s].toFixed(2),
    direct: directTotals[s].toFixed(2),
    total: totals[s].toFixed(2),
  })),
);

// Duplicate check
const seen = new Set();
const dups = [];
for (const r of real) {
  const k = `${r.range_from}|${r.store_id}`;
  if (seen.has(k)) dups.push(k);
  seen.add(k);
}
console.log("Duplicates:", dups.length);

// Bad store_ids in April per-day
const badRows = data.filter(
  (r) =>
    r.range_from === r.range_to &&
    !["NOVA", "NURA", "KOVA"].includes(r.store_id),
);
console.log("Bad store_id rows in April per-day:", badRows.length);
if (badRows.length) console.table(badRows.map((r) => ({ store: r.store_id, date: r.range_from })));

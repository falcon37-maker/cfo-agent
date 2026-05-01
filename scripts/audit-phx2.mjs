// Step 0a follow-on: monthly subtotals + a raw_json sample.
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

// Monthly per-store subtotals across all rows where range_from = range_to
const { data: all } = await sb
  .from("phx_summary_snapshots")
  .select(
    "store_id, range_from, range_to, revenue_initial, revenue_recurring, revenue_salvage, revenue_direct, revenue_upsell, revenue_total",
  )
  .eq("tenant_id", TENANT)
  .order("range_from");

const perDay = (all ?? []).filter(
  (r) => r.range_from === r.range_to && ["NOVA", "NURA", "KOVA"].includes(r.store_id),
);
const byMonthStore = new Map();
for (const r of perDay) {
  const month = r.range_from.slice(0, 7);
  const key = `${month}|${r.store_id}`;
  const e = byMonthStore.get(key) ?? {
    month,
    store: r.store_id,
    init: 0,
    recur: 0,
    salv: 0,
    direct: 0,
    upsell: 0,
    total: 0,
    days: 0,
  };
  e.init += Number(r.revenue_initial ?? 0);
  e.recur += Number(r.revenue_recurring ?? 0);
  e.salv += Number(r.revenue_salvage ?? 0);
  e.direct += Number(r.revenue_direct ?? 0);
  e.upsell += Number(r.revenue_upsell ?? 0);
  e.total += Number(r.revenue_total ?? 0);
  e.days += 1;
  byMonthStore.set(key, e);
}

console.log("=== Monthly per-store subtotals (per-day rows only) ===");
console.table(
  [...byMonthStore.values()]
    .sort((a, b) => (a.month + a.store).localeCompare(b.month + b.store))
    .map((e) => ({
      month: e.month,
      store: e.store,
      days: e.days,
      init: e.init.toFixed(2),
      recur: e.recur.toFixed(2),
      salv: e.salv.toFixed(2),
      direct: e.direct.toFixed(2),
      upsell: e.upsell.toFixed(2),
      total: e.total.toFixed(2),
    })),
);

// Sample raw_json for a known-good NOVA day
const { data: sample } = await sb
  .from("phx_summary_snapshots")
  .select("store_id, range_from, raw_json")
  .eq("tenant_id", TENANT)
  .eq("store_id", "NOVA")
  .eq("range_from", "2026-04-15")
  .single();
console.log("\n=== raw_json sample (NOVA 2026-04-15) ===");
console.log(JSON.stringify(sample?.raw_json, null, 2));

// Sanity: are there any stores in the per-day data we don't recognize?
const distinctStores = new Set(perDay.map((r) => r.store_id));
console.log("\nDistinct per-day store_ids:", [...distinctStores].sort().join(", "));

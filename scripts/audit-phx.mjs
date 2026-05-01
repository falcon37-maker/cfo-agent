// Step 0a audit: dump phx_summary_snapshots for Joseph's tenant.
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

// Total row count
const { count: total } = await sb
  .from("phx_summary_snapshots")
  .select("*", { count: "exact", head: true })
  .eq("tenant_id", TENANT);
console.log(`Total rows for tenant: ${total}`);

// All rows in April 2026, ordered
const { data, error } = await sb
  .from("phx_summary_snapshots")
  .select(
    "store_id, range_from, range_to, scrape_date, revenue_direct, revenue_initial, revenue_recurring, revenue_salvage, revenue_upsell, revenue_total, raw_json",
  )
  .eq("tenant_id", TENANT)
  .gte("range_from", "2026-04-01")
  .lte("range_from", "2026-04-30")
  .order("range_from", { ascending: true })
  .order("store_id", { ascending: true });
if (error) {
  console.error(error);
  process.exit(1);
}
console.log(`\nApril rows: ${data.length}`);
console.table(
  data.map((r) => ({
    range_from: r.range_from,
    range_to: r.range_to,
    store: r.store_id,
    init: r.revenue_initial,
    recur: r.revenue_recurring,
    salv: r.revenue_salvage,
    direct: r.revenue_direct,
    upsell: r.revenue_upsell,
    total: r.revenue_total,
    perDay: r.range_from === r.range_to ? "Y" : "N",
  })),
);

// Rows with weird store_ids
const { data: weird } = await sb
  .from("phx_summary_snapshots")
  .select("store_id, range_from, range_to, revenue_total")
  .eq("tenant_id", TENANT)
  .in("store_id", ["__BACKFILL_DEDUPE__", "PORTFOLIO"]);
console.log(`\nDedupe / PORTFOLIO rows: ${weird?.length ?? 0}`);
if (weird?.length) console.table(weird);

// Date-coverage check across all time
const { data: all } = await sb
  .from("phx_summary_snapshots")
  .select("range_from, range_to, store_id, revenue_total")
  .eq("tenant_id", TENANT)
  .order("range_from", { ascending: true });
const distinctDays = new Set(
  all
    ?.filter((r) => r.range_from === r.range_to && !["__BACKFILL_DEDUPE__", "PORTFOLIO"].includes(r.store_id))
    .map((r) => r.range_from),
);
console.log(`\nDistinct per-day dates (excluding dedupe/PORTFOLIO): ${distinctDays.size}`);
console.log(`Earliest: ${[...distinctDays].sort()[0]}`);
console.log(`Latest:   ${[...distinctDays].sort().slice(-1)[0]}`);

// Multi-day rows (range_from != range_to)
const periodRows = all?.filter((r) => r.range_from !== r.range_to) ?? [];
console.log(`\nPeriod rows (range_from != range_to): ${periodRows.length}`);
if (periodRows.length) console.table(periodRows.slice(0, 20));

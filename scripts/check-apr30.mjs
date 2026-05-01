import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";
const { data } = await sb.from("phx_summary_snapshots").select("store_id, range_from, revenue_initial, revenue_recurring, revenue_salvage, revenue_direct, revenue_total, raw_json, scrape_date, scraped_at").eq("tenant_id", T).eq("range_from", "2026-04-30").eq("range_to", "2026-04-30");
console.log("Apr 30 rows:");
console.table(data.map(r => ({
  store: r.store_id,
  scraped: r.scraped_at?.slice(0,19),
  init: Number(r.revenue_initial ?? 0).toFixed(2),
  recur: Number(r.revenue_recurring ?? 0).toFixed(2),
  direct: Number(r.revenue_direct ?? 0).toFixed(2),
  total: Number(r.revenue_total ?? 0).toFixed(2),
  customersSeen: r.raw_json?.customersSeen,
  initCount: r.raw_json?.initialCount,
  recurCount: r.raw_json?.recurringCount,
})));

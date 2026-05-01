// Inspect daily_pnl rows the dashboard's Frontend column would read.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";

// Daily PnL rows for Apr 14, 15, 18
const dates = ["2026-04-14", "2026-04-15", "2026-04-18"];
for (const d of dates) {
  const { data } = await sb.from("daily_pnl")
    .select("store_id, date, revenue, order_count, ad_spend")
    .eq("tenant_id", T).eq("date", d).order("store_id");
  console.log(`\n=== ${d} ===`);
  console.table(data);
  const total = (data ?? []).reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  console.log(`Total revenue this date: $${total.toFixed(2)}`);
}

// Per-store list
const { data: stores } = await sb.from("stores")
  .select("id, name, shop_domain, is_active, solvpath_store_code")
  .eq("tenant_id", T).eq("is_active", true);
console.log("\n=== Stores (PHX = has solvpath_store_code) ===");
console.table(stores);

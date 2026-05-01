import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";

const { data: portfolio } = await sb
  .from("phx_summary_snapshots")
  .select("*")
  .eq("tenant_id", T)
  .eq("store_id", "PORTFOLIO");
console.log(`PORTFOLIO rows: ${portfolio?.length ?? 0}`);

const { data: sample } = await sb
  .from("phx_summary_snapshots")
  .select("store_id, range_from, active_subscribers, cancelled_subscribers, subscribers_in_salvage, revenue_total")
  .eq("tenant_id", T)
  .gte("range_from", "2026-04-28")
  .order("range_from")
  .order("store_id");
console.log("\nSample per-store/per-day rows (Apr 28-30) — subscriber counts:");
console.table(sample);

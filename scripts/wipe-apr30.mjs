// Delete the corrupted Apr 30 rows (double-counted by partial cron run) +
// the Apr 30 dedupe marker so a fresh cron invocation rebuilds cleanly.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("/Users/joegomez/cfo-agent/.env.local", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const T = "116dc838-df19-44ba-9b93-92ab7be371a8";

const { data: before } = await sb
  .from("phx_summary_snapshots")
  .select("id, store_id, range_from, range_to")
  .eq("tenant_id", T)
  .eq("range_from", "2026-04-30")
  .eq("range_to", "2026-04-30");
console.log("Apr 30 rows before:");
console.table(before);

const { error } = await sb
  .from("phx_summary_snapshots")
  .delete()
  .eq("tenant_id", T)
  .eq("range_from", "2026-04-30")
  .eq("range_to", "2026-04-30");
if (error) throw error;

const { data: after } = await sb
  .from("phx_summary_snapshots")
  .select("id")
  .eq("tenant_id", T)
  .eq("range_from", "2026-04-30")
  .eq("range_to", "2026-04-30");
console.log(`After: ${after?.length ?? 0} rows remaining (should be 0)`);

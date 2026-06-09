// "customer_data" — subscriber-level metrics from PHX.
//
// DB tables used:
//   phx_summary_snapshots
//     - active_subscribers, cancelled_subscribers, subscribers_in_salvage
//     - new_subscribers, net_subscribers, cancelled_subscribers_period
//     - subscriptions_to_bill, target_cac
//     - total_transactions_mtd, refunds_mtd_count
//
// We deliberately DON'T expose customer PII (emails) through the agent.
// Subscriber-level identifiers stay in the dashboard pages where the
// security model is row-aware.
//
// Possible questions this handles:
//   - "how many new subscribers this week?"
//   - "subscriptions to bill"
//   - "MTD transactions"
//   - "subscribers in salvage"
//   - "net subscriber change this month"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CategoryModule } from "./_base";

const phxStoreId = z.enum(["NOVA", "NURA", "KOVA"]);

const rangeSchema = z.object({
  store_id: phxStoreId.optional(),
});

type RangeInput = z.infer<typeof rangeSchema>;

export const customerDataCategory: CategoryModule = {
  id: "customer_data",
  name: "Customer Data",

  description:
    "Subscriber-level activity from PHX — new/cancelled counts, subscriptions queued to bill, transactions month-to-date, salvage pool size. Does NOT expose customer PII like emails.",

  examples: [
    "how many new subscribers this week?",
    "subscriptions to bill",
    "MTD transactions",
    "subscribers in salvage",
    "net subscriber change",
    "salvage pool",
  ],

  prompt: `# Mode: Customer Data

The user is asking about subscriber population mechanics — not revenue.

Reply rules:
- All numbers come from the latest PHX snapshot. Mention the snapshot date if relevant.
- "Subs to bill" = upcoming scheduled rebills, not active count.
- "MTD transactions" = total billing attempts month-to-date (successes + failures).
- Don't expose any customer email or identifier; we only deal in counts.
- If the user explicitly asks for customer PII, decline politely.`,

  queries: [
    {
      id: "latest_snapshot",
      description:
        "Pull the latest PHX snapshot's subscriber-level fields (active, cancelled, salvage, new, net, to_bill, MTD transactions).",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const sb = supabaseAdmin();
        const targetStore = raw.store_id ?? "PORTFOLIO";
        const { data } = await sb
          .from("phx_summary_snapshots")
          .select(
            "store_id, range_from, range_to, scraped_at, active_subscribers, cancelled_subscribers, subscribers_in_salvage, new_subscribers, net_subscribers, cancelled_subscribers_period, subscriptions_to_bill, total_transactions_mtd, refunds_mtd_count, target_cac",
          )
          .eq("tenant_id", ctx.tenantId)
          .eq("store_id", targetStore)
          .order("range_to", { ascending: false })
          .order("scraped_at", { ascending: false })
          .limit(1);
        const row = (data?.[0] ?? null) as
          | Record<string, unknown>
          | null;
        if (!row) {
          return {
            available: false,
            note: `No snapshot found for ${targetStore}.`,
          };
        }
        return {
          available: true,
          store_id: targetStore,
          snapshot_date: row.range_to,
          scraped_at: row.scraped_at,
          active_subscribers: numOr0(row.active_subscribers),
          cancelled_subscribers: numOr0(row.cancelled_subscribers),
          subscribers_in_salvage: numOr0(row.subscribers_in_salvage),
          new_subscribers: numOrNull(row.new_subscribers),
          net_change: numOrNull(row.net_subscribers),
          cancelled_in_period: numOrNull(row.cancelled_subscribers_period),
          subscriptions_to_bill: numOrNull(row.subscriptions_to_bill),
          transactions_mtd: numOrNull(row.total_transactions_mtd),
          refunds_mtd_count: numOrNull(row.refunds_mtd_count),
          target_cac_usd: numOrNull(row.target_cac),
        };
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "how many subs are in salvage?",
    "what's the net subscriber change this month?",
    "how many subs are queued to bill?",
  ],
};

function numOr0(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

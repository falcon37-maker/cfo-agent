// "refunds" — refund analysis from both Shopify side and PHX side.
//
// DB tables used:
//   daily_pnl
//     - refunds                       (Shopify refunds rollup)
//   phx_summary_snapshots
//     - refund_total                  (sum of refund categories below)
//     - refund_agent, refund_ethoca, refund_cdrn,
//       refund_rdr_withdrawals, refund_chargeback_withdrawals
//     - refunds_mtd_count, refunds_mtd_pct
//
// Possible questions this handles:
//   - "how much have we refunded this month?"
//   - "refund rate"
//   - "refund breakdown by source"
//   - "are refunds going up?"
//   - "agent refunds vs ethoca"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadPnlLedger } from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rangeSchema = z
  .object({
    days: z.number().int().positive().max(365).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
  })
  .refine(
    (v) => v.days != null || (v.from != null && v.to != null),
    "Provide either { days } or { from, to }",
  );

type RangeInput = z.infer<typeof rangeSchema>;

function resolveRange(input: RangeInput) {
  if (input.from && input.to) {
    const days = diffDays(input.from, input.to) + 1;
    return { from: input.from, to: input.to, days };
  }
  const days = input.days ?? 30;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const refundsCategory: CategoryModule = {
  id: "refunds",
  name: "Refunds",

  description:
    "Refund totals and breakdown. Covers both Shopify-side refunds (in daily_pnl) and PHX refund categories (agent / ethoca / cdrn / rdr / chargeback). Use when the user asks about refund amounts, refund rate, or refund sources.",

  examples: [
    "how much have we refunded this month?",
    "refund rate",
    "refund breakdown",
    "agent refunds last 30 days",
    "PHX refunds by source",
    "ethoca refunds",
  ],

  prompt: `# Mode: Refunds

The user is asking about refunds.

Reply rules:
- Shopify-side refunds come from daily_pnl.refunds.
- PHX-side refunds are split into categories: agent (manual), ethoca, cdrn, rdr withdrawals, chargeback withdrawals.
- Refund rate = refunds / total_revenue × 100.
- When asked for "total refunds", combine Shopify + PHX side and label each.
- If a category is $0, mention it only if relevant — don't pad the answer.`,

  queries: [
    {
      id: "totals_combined",
      description:
        "Combined refund total (Shopify + PHX) plus refund rate for a date range.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(spec, "all", ctx.tenantId);
        const sb = supabaseAdmin();
        const { data } = await sb
          .from("phx_summary_snapshots")
          .select(
            "range_from, range_to, refund_total, refund_agent, refund_ethoca, refund_cdrn, refund_rdr_withdrawals, refund_chargeback_withdrawals",
          )
          .eq("tenant_id", ctx.tenantId)
          .in("store_id", ["NOVA", "NURA", "KOVA"])
          .gte("range_from", spec.from)
          .lte("range_to", spec.to);
        const phx = {
          total: 0,
          agent: 0,
          ethoca: 0,
          cdrn: 0,
          rdr: 0,
          chargeback: 0,
        };
        for (const r of (data ?? []) as Array<{
          range_from: string;
          range_to: string;
          refund_total: number | null;
          refund_agent: number | null;
          refund_ethoca: number | null;
          refund_cdrn: number | null;
          refund_rdr_withdrawals: number | null;
          refund_chargeback_withdrawals: number | null;
        }>) {
          if (r.range_from !== r.range_to) continue;
          phx.total += Number(r.refund_total ?? 0);
          phx.agent += Number(r.refund_agent ?? 0);
          phx.ethoca += Number(r.refund_ethoca ?? 0);
          phx.cdrn += Number(r.refund_cdrn ?? 0);
          phx.rdr += Number(r.refund_rdr_withdrawals ?? 0);
          phx.chargeback += Number(r.refund_chargeback_withdrawals ?? 0);
        }
        const shopifyRefunds = ledger.totals.refunds;
        const totalRefunds = shopifyRefunds + phx.total;
        const refundRate =
          ledger.totals.total_revenue > 0
            ? (totalRefunds / ledger.totals.total_revenue) * 100
            : 0;
        return {
          range: spec,
          shopify_refunds: round(shopifyRefunds),
          phx_refunds_total: round(phx.total),
          phx_breakdown: {
            agent: round(phx.agent),
            ethoca: round(phx.ethoca),
            cdrn: round(phx.cdrn),
            rdr: round(phx.rdr),
            chargeback: round(phx.chargeback),
          },
          total_refunds: round(totalRefunds),
          revenue: round(ledger.totals.total_revenue),
          refund_rate_pct: round(refundRate, 2),
        };
      },
      table_threshold: null,
    },
    {
      id: "phx_breakdown_table",
      description:
        "Per-category PHX refund breakdown in table form. Use when the user wants the full split.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        const { data } = await sb
          .from("phx_summary_snapshots")
          .select(
            "range_from, range_to, refund_agent, refund_ethoca, refund_cdrn, refund_rdr_withdrawals, refund_chargeback_withdrawals",
          )
          .eq("tenant_id", ctx.tenantId)
          .in("store_id", ["NOVA", "NURA", "KOVA"])
          .gte("range_from", spec.from)
          .lte("range_to", spec.to);
        const totals: Record<string, number> = {
          agent: 0,
          ethoca: 0,
          cdrn: 0,
          rdr: 0,
          chargeback: 0,
        };
        for (const r of (data ?? []) as Array<{
          range_from: string;
          range_to: string;
          refund_agent: number | null;
          refund_ethoca: number | null;
          refund_cdrn: number | null;
          refund_rdr_withdrawals: number | null;
          refund_chargeback_withdrawals: number | null;
        }>) {
          if (r.range_from !== r.range_to) continue;
          totals.agent += Number(r.refund_agent ?? 0);
          totals.ethoca += Number(r.refund_ethoca ?? 0);
          totals.cdrn += Number(r.refund_cdrn ?? 0);
          totals.rdr += Number(r.refund_rdr_withdrawals ?? 0);
          totals.chargeback += Number(r.refund_chargeback_withdrawals ?? 0);
        }
        return Object.entries(totals).map(([source, amount]) => ({
          source,
          amount: round(amount),
        }));
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "what's the refund rate?",
    "show me agent refunds",
    "compare refunds to last period",
  ],
};

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

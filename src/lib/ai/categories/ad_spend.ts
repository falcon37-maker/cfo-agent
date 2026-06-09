// "ad_spend" — advertising spend + ROAS.
//
// DB tables used:
//   daily_ad_spend     (per-platform daily totals from sync; PK store_id+date+platform)
//   ad_spend_entries   (manual log; audit trail)
//   daily_pnl          (revenue side for ROAS calculation)
//
// Possible questions this handles:
//   - "how much did we spend on ads this week?"
//   - "ad spend trend for NOVA"
//   - "ROAS this month"
//   - "ad spend by platform"
//   - "which day had no ad spend?"
//   - "compare meta vs google spend"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadPnlLedger } from "@/lib/pnl/queries";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const storeId = z.string().min(1).max(32).regex(/^[A-Z0-9_]+$/);

const baseSchema = z.object({
  days: z.number().int().positive().max(365).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  store_id: storeId.optional(),
  platform: z.string().min(1).max(32).optional(),
});

const rangeSchema = baseSchema.refine(
  (v) => v.days != null || (v.from != null && v.to != null),
  "Provide either { days } or { from, to }",
);

type RangeInput = z.infer<typeof rangeSchema>;

function resolveRange(input: RangeInput) {
  if (input.from && input.to) {
    const days = diffDays(input.from, input.to) + 1;
    return { from: input.from, to: input.to, days };
  }
  const days = input.days ?? 7;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const adSpendCategory: CategoryModule = {
  id: "ad_spend",
  name: "Ad Spend",

  description:
    "Advertising spend + ROAS analysis. Covers daily spend totals, per-platform breakdown (Meta/Google/etc.), ROAS calculations. Use this when the user asks specifically about ads/marketing spend.",

  examples: [
    "how much did we spend on ads this week?",
    "ad spend for NOVA",
    "ROAS this month",
    "ad spend by platform",
    "which day had no ad spend?",
    "total ad spend last 30 days",
    "meta vs google spend",
  ],

  prompt: `# Mode: Ad Spend

The user is asking about advertising spend.

Reply rules:
- ROAS = total_revenue / ad_spend. If ad_spend is 0, ROAS is undefined — say so plainly.
- Don't confuse ad_spend (what we paid) with revenue. Keep them clearly separate in the sentence.
- If a day shows $0 ad spend, flag it briefly (often means a logging gap, not actual zero).
- For platform splits, name the top 1-2 platforms by spend.`,

  queries: [
    {
      id: "total_with_roas",
      description:
        "Get total ad spend + revenue + ROAS for a date range. Best for 'ad spend this week' / 'ROAS this month'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(
          spec,
          raw.store_id ? [raw.store_id] : "all",
          ctx.tenantId,
        );
        return {
          range: spec,
          store_id: raw.store_id ?? "all",
          ad_spend: round(ledger.totals.ad_spend),
          revenue: round(ledger.totals.total_revenue),
          roas:
            ledger.totals.ad_spend > 0
              ? round(ledger.totals.total_revenue / ledger.totals.ad_spend, 2)
              : null,
        };
      },
      table_threshold: null,
    },
    {
      id: "by_platform",
      description:
        "Ad spend grouped by platform (Meta, Google, etc.) over a range. Use for 'platform breakdown' / 'meta vs google'.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        let q = sb
          .from("daily_ad_spend")
          .select("platform, spend, impressions, clicks")
          .eq("tenant_id", ctx.tenantId)
          .gte("date", spec.from)
          .lte("date", spec.to);
        if (raw.store_id) q = q.eq("store_id", raw.store_id);
        if (raw.platform) q = q.eq("platform", raw.platform);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const byPlatform = new Map<
          string,
          { spend: number; impressions: number; clicks: number }
        >();
        for (const r of (data ?? []) as Array<{
          platform: string;
          spend: number | null;
          impressions: number | null;
          clicks: number | null;
        }>) {
          const cur =
            byPlatform.get(r.platform) ?? {
              spend: 0,
              impressions: 0,
              clicks: 0,
            };
          cur.spend += Number(r.spend ?? 0);
          cur.impressions += Number(r.impressions ?? 0);
          cur.clicks += Number(r.clicks ?? 0);
          byPlatform.set(r.platform, cur);
        }
        return Array.from(byPlatform.entries())
          .sort((a, b) => b[1].spend - a[1].spend)
          .map(([platform, t]) => ({
            platform,
            spend: round(t.spend),
            impressions: t.impressions,
            clicks: t.clicks,
          }));
      },
      table_threshold: null,
    },
    {
      id: "daily_trend",
      description:
        "Day-by-day ad spend over a range. Use when user wants the trend / chart-style view.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const ledger = await loadPnlLedger(
          spec,
          raw.store_id ? [raw.store_id] : "all",
          ctx.tenantId,
        );
        return ledger.rows.map((r) => ({
          date: r.date,
          ad_spend: round(r.ad_spend),
          revenue: round(r.total_revenue),
          roas: r.ad_spend > 0 ? round(r.total_revenue / r.ad_spend, 2) : null,
        }));
      },
      table_threshold: 10,
      table_columns: ["date", "ad_spend", "revenue", "roas"],
      table_column_labels: {
        ad_spend: "Ad Spend",
        revenue: "Revenue",
        roas: "ROAS",
      },
      table_column_format: {
        roas: "int",
      },
    },
    {
      id: "recent_manual_entries",
      description:
        "List recent manual ad-spend entries with who submitted them. Use for audit-style questions.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        let q = sb
          .from("ad_spend_entries")
          .select("date, store_id, amount, submitted_by, submitted_at")
          .eq("tenant_id", ctx.tenantId)
          .gte("date", spec.from)
          .lte("date", spec.to)
          .order("submitted_at", { ascending: false })
          .limit(30);
        if (raw.store_id) q = q.eq("store_id", raw.store_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return (data ?? []).map((r) => ({
          date: r.date,
          store_id: r.store_id,
          amount: round(Number(r.amount ?? 0)),
          submitted_by: r.submitted_by ?? "—",
          submitted_at: String(r.submitted_at ?? "").slice(0, 10),
        }));
      },
      table_threshold: 8,
      table_columns: [
        "date",
        "store_id",
        "amount",
        "submitted_by",
        "submitted_at",
      ],
      table_column_labels: {
        date: "Date",
        store_id: "Store",
        amount: "Amount",
        submitted_by: "By",
        submitted_at: "Logged",
      },
    },
  ],

  fallback_suggestions: [
    "show ROAS trend by day",
    "which platform got the most spend?",
    "ad spend vs revenue this month",
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

// "operations" — sync health + integration status.
//
// DB tables used:
//   integrations          (last_synced_at, is_active per provider)
//   stores                (latest sync timestamps via daily_orders / daily_pnl)
//   phx_summary_snapshots (latest scraped_at)
//   chargeblast_alerts    (latest created_at)
//   daily_pnl             (latest computed_at)
//
// Possible questions this handles:
//   - "are integrations healthy?"
//   - "when was the last sync?"
//   - "is Shopify sync working?"
//   - "last Solvpath update"
//   - "any data sync issues?"

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CategoryModule } from "./_base";

export const operationsCategory: CategoryModule = {
  id: "operations",
  name: "Operations",

  description:
    "System health / sync status / integration freshness. Use when the user asks 'is sync working?', 'when was last update?', 'any data issues?'.",

  examples: [
    "are integrations healthy?",
    "when was the last sync?",
    "is Shopify sync working?",
    "last Solvpath update",
    "any data sync issues?",
    "freshness check",
  ],

  prompt: `# Mode: Operations

The user is asking about system health, sync status, or data freshness.

Reply rules:
- Lead with the worst freshness number (e.g. "Solvpath synced 3 hours ago; everything else is current").
- "Stale" = older than 36 hours for daily-cadence syncs, older than 6 hours for hourly-cadence syncs.
- If something is stale, name it and the last-seen time. Don't pretend things are fine if they aren't.
- Don't suggest fixes — that's not your job here. Just report status.`,

  queries: [
    {
      id: "sync_status",
      description:
        "Get the latest sync / data-freshness timestamps for every integration.",
      params_schema: z.object({}),
      run: async (_in, ctx) => {
        const sb = supabaseAdmin();
        const tid = ctx.tenantId;
        const [integrations, pnl, phx, cb] = await Promise.all([
          sb
            .from("integrations")
            .select("provider, is_active, last_synced_at")
            .eq("tenant_id", tid),
          sb
            .from("daily_pnl")
            .select("computed_at")
            .eq("tenant_id", tid)
            .order("computed_at", { ascending: false })
            .limit(1),
          sb
            .from("phx_summary_snapshots")
            .select("scraped_at")
            .eq("tenant_id", tid)
            .order("scraped_at", { ascending: false })
            .limit(1),
          sb
            .from("chargeblast_alerts")
            .select("chargeblast_created_at")
            .eq("tenant_id", tid)
            .order("chargeblast_created_at", { ascending: false })
            .limit(1),
        ]);

        const now = Date.now();
        const ageHours = (iso: string | null | undefined): number | null => {
          if (!iso) return null;
          const t = new Date(iso).getTime();
          return Number.isFinite(t)
            ? round((now - t) / (1000 * 60 * 60), 1)
            : null;
        };

        const integ = (integrations.data ?? []) as Array<{
          provider: string;
          is_active: boolean | null;
          last_synced_at: string | null;
        }>;

        return {
          providers: integ.map((p) => ({
            provider: p.provider,
            is_active: !!p.is_active,
            last_synced_at: p.last_synced_at,
            hours_since: ageHours(p.last_synced_at),
          })),
          daily_pnl: {
            last_computed: pnl.data?.[0]?.computed_at ?? null,
            hours_since: ageHours(pnl.data?.[0]?.computed_at),
          },
          solvpath_snapshot: {
            last_scraped: phx.data?.[0]?.scraped_at ?? null,
            hours_since: ageHours(phx.data?.[0]?.scraped_at),
          },
          chargeblast: {
            last_alert: cb.data?.[0]?.chargeblast_created_at ?? null,
            hours_since: ageHours(cb.data?.[0]?.chargeblast_created_at),
          },
        };
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "when was Shopify last synced?",
    "any stale data sources?",
    "is Solvpath up to date?",
  ],
};

function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

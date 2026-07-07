// MCP sync tools — let Claude pull fresh data on demand ("sync today's
// Paysight", "sync Phoenix for the last 3 days"). Thin wrappers over the
// existing sync functions in src/lib/**. Every wrapper is tenant-scoped and
// returns a small JSON summary Claude can report back. No new business logic.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncPaysightDay } from "@/lib/paysight/sync";
import { syncDailyOrders } from "@/lib/shopify/sync";
import { computeDailyPnl } from "@/lib/pnl/compute";
import { hasStoreCreds } from "@/lib/shopify/stores";
import { syncPhoenixPortalRange } from "@/lib/phoenix-portal/sync";
import { syncAlerts } from "@/lib/chargeblast/sync";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD (UTC). Claude usually means "today" when no date given. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveDate(args: Record<string, unknown>): string {
  const d = typeof args.date === "string" ? args.date : "";
  return DATE_RE.test(d) ? d : todayUtc();
}

// ── Tool definitions ──────────────────────────────────────────────────────
export const SYNC_TOOLS: Tool[] = [
  {
    name: "sync_paysight",
    description:
      "Pull fresh Paysight data (subscriptions + transactions) for a single day and store it. Defaults to today. Use when the user says 'sync Paysight' or 'refresh today's Paysight'.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Day to sync, YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sync_shopify",
    description:
      "Pull fresh Shopify orders + recompute P&L for one store (or all stores) for a single day. Defaults to today, all stores. Use for 'sync Shopify' / 'refresh today's orders'.",
    inputSchema: {
      type: "object",
      properties: {
        store_id: { type: "string", description: "Store code (e.g. NOVA). Omit to sync every store with credentials." },
        date: { type: "string", description: "Day to sync, YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sync_phoenix",
    description:
      "Pull fresh Phoenix/Solvpath subscription snapshots for a date range (max 14 days). Defaults to today. Use for 'sync Phoenix' / 'refresh subscriber counts'.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start day YYYY-MM-DD. Defaults to today." },
        to: { type: "string", description: "End day YYYY-MM-DD. Defaults to `from`." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sync_chargeblast",
    description:
      "Pull fresh Chargeblast chargeback alerts for a date range and store them. Defaults to the last 7 days. Use for 'sync chargebacks'.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start day YYYY-MM-DD. Defaults to 7 days ago." },
        to: { type: "string", description: "End day YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
  },
];

export const SYNC_TOOL_NAMES = new Set(SYNC_TOOLS.map((t) => t.name));

// ── Executors ─────────────────────────────────────────────────────────────

/** Every store that has Shopify credentials for this tenant. */
async function storesWithCreds(tenantId: string): Promise<string[]> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("stores")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .neq("id", "PORTFOLIO");
  const ids = (data ?? []).map((r) => r.id as string);
  const out: string[] = [];
  for (const id of ids) {
    if (await hasStoreCreds(id, tenantId)) out.push(id);
  }
  return out;
}

export async function runSyncTool(
  name: string,
  args: Record<string, unknown>,
  tenantId: string,
): Promise<unknown> {
  switch (name) {
    case "sync_paysight": {
      const date = resolveDate(args);
      const r = await syncPaysightDay(tenantId, date);
      return { ok: true, date, ...r };
    }

    case "sync_shopify": {
      const date = resolveDate(args);
      const only = typeof args.store_id === "string" ? args.store_id.toUpperCase() : null;
      const stores = only ? [only] : await storesWithCreds(tenantId);
      const results: Array<Record<string, unknown>> = [];
      for (const storeId of stores) {
        try {
          const pull = await syncDailyOrders(storeId, date, tenantId);
          const pnl = await computeDailyPnl(storeId, date, tenantId);
          results.push({
            store_id: storeId,
            orders: pull.orderCount ?? null,
            revenue: pnl?.revenue ?? null,
            net_profit: pnl?.net_profit ?? null,
          });
        } catch (e) {
          results.push({ store_id: storeId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { ok: true, date, stores_synced: results.length, results };
    }

    case "sync_phoenix": {
      const from = DATE_RE.test(String(args.from)) ? String(args.from) : todayUtc();
      const to = DATE_RE.test(String(args.to)) ? String(args.to) : from;
      const days = await syncPhoenixPortalRange(tenantId, from, to);
      return { ok: true, from, to, days_synced: days.length };
    }

    case "sync_chargeblast": {
      const to = DATE_RE.test(String(args.to)) ? String(args.to) : todayUtc();
      const from = DATE_RE.test(String(args.from))
        ? String(args.from)
        : new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const r = await syncAlerts(tenantId, { start_date: from, end_date: to });
      return { ok: true, from, to, ...r };
    }

    default:
      throw new Error(`Unknown sync tool: ${name}`);
  }
}

// Hourly incremental sync — runs every hour.
//
// Pulls the LAST 3 DAYS (today + yesterday + day-before) for every source so
// the dashboard stays near-real-time and late changes (refunds,
// cancellations, captured-later transactions, cross-midnight boundary rows)
// self-correct within the rolling window:
//
//   • Shopify   — daily_orders + daily_pnl per store
//   • Paysight  — paysight_subscriptions + paysight_transactions
//   • Phoenix   — PORTFOLIO subscriber-count snapshot (fast: TotalCount per
//                 status). NOTE: Phoenix per-customer REVENUE backfill is
//                 heavy (~5700 customers) and is handled by the daily-full
//                 cron, not here, to keep the hourly run fast.
//
// Auth: Bearer $CRON_SECRET (Vercel cron header). ?secret= for manual runs.
// ?days=N overrides the window (default 3, max 7).

import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncDailyOrders } from "@/lib/shopify/sync";
import { computeDailyPnl } from "@/lib/pnl/compute";
import { hasStoreCreds } from "@/lib/shopify/stores";
import { syncPaysightDay } from "@/lib/paysight/sync";
import { getPaysightCreds } from "@/lib/integrations";
import { listCustomers } from "@/lib/solvpath/client";
import { SUBSCRIBER_STATUSES } from "@/lib/solvpath/sync";
import { getSolvpathCreds } from "@/lib/integrations";
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const h = req.headers.get("authorization");
  const q = req.nextUrl.searchParams.get("secret");
  return h === `Bearer ${expected}` || q === expected;
}

/** Last N days in tz as YYYY-MM-DD, newest first. */
function lastNDaysInTz(tz: string, n: number): string[] {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return out;
}
function lastNDaysUtc(n: number): string[] {
  const out: string[] = [];
  const t = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(t);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Quick Phoenix PORTFOLIO subscriber-count snapshot (one Limit=1 call per status). */
async function syncPhoenixCounts(tenantId: string): Promise<{
  ok: boolean;
  counts?: Record<string, number>;
  error?: string;
}> {
  try {
    const counts: Record<string, number> = {};
    for (const status of SUBSCRIBER_STATUSES) {
      const r = await listCustomers(tenantId, {
        Page: 1,
        Limit: 1,
        SubscriptionStatus: status,
      });
      counts[status] = r.TotalCount ?? 0;
    }
    const today = new Date().toISOString().slice(0, 10);
    const sb = supabaseAdmin();
    const { error } = await sb.from("phx_summary_snapshots").upsert(
      {
        tenant_id: tenantId,
        store_id: "PORTFOLIO",
        range_from: today,
        range_to: today,
        scrape_date: today,
        scraped_at: new Date().toISOString(),
        active_subscribers: counts["Active"] ?? 0,
        cancelled_subscribers: counts["Canceled"] ?? 0,
        subscribers_in_salvage: null,
        raw_json: { source: "cron.sync-hourly", counts },
      },
      { onConflict: "tenant_id,store_id,range_from,range_to" },
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handle(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(req)) return unauthorized();

  const daysParam = req.nextUrl.searchParams.get("days");
  const parsed = daysParam ? Number(daysParam) : NaN;
  const windowDays =
    Number.isFinite(parsed) && parsed > 0 ? Math.min(7, Math.floor(parsed)) : 3;

  const started = Date.now();
  const sb = supabaseAdmin();
  const tenants = await listActiveTenants();

  const shopify: Array<Record<string, unknown>> = [];
  const paysight: Array<Record<string, unknown>> = [];
  const phoenix: Array<Record<string, unknown>> = [];

  for (const tenant of tenants) {
    // ── Shopify (per store, rolling window) ──
    const { data: stores } = await sb
      .from("stores")
      .select("id, timezone")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .neq("id", "PORTFOLIO")
      .neq("id", "__BACKFILL_DEDUPE__");
    for (const store of stores ?? []) {
      if (!(await hasStoreCreds(store.id, tenant.id))) continue;
      const dates = lastNDaysInTz(store.timezone ?? "UTC", windowDays);
      for (const date of dates) {
        try {
          const pull = await syncDailyOrders(store.id, date, tenant.id);
          await computeDailyPnl(store.id, date, tenant.id);
          shopify.push({
            store: store.id,
            date,
            ok: true,
            orders: pull.orderCount,
          });
        } catch (err) {
          shopify.push({
            store: store.id,
            date,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Paysight (rolling window) ──
    const pCreds = await getPaysightCreds(tenant.id);
    if (pCreds) {
      for (const date of lastNDaysUtc(windowDays)) {
        try {
          const r = await syncPaysightDay(tenant.id, date);
          paysight.push({
            date,
            ok: true,
            subs: r.subscriptionsUpserted,
            tx: r.transactionsUpserted,
          });
        } catch (err) {
          paysight.push({
            date,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Phoenix counts (fast snapshot) ──
    const sCreds = await getSolvpathCreds(tenant.id);
    if (sCreds) {
      const r = await syncPhoenixCounts(tenant.id);
      phoenix.push({ tenant: tenant.display_name, ...r });
    }
  }

  return Response.json({
    ok: true,
    mode: "hourly-incremental",
    windowDays,
    ranAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    shopify,
    paysight,
    phoenix,
  });
}

export const GET = handle;
export const POST = handle;

// Daily full backfill — runs once per day.
//
// Re-pulls EVERYTHING from the start of the previous month through today,
// so any data that drifted (late refunds, re-captured transactions,
// corrections on the source platforms) is fully reconciled once a day:
//
//   • Shopify   — backfillRange per store → daily_orders + daily_pnl
//   • Paysight  — syncPaysightDay per day → paysight_subscriptions/transactions
//   • Phoenix   — backfillRevenueForRange (chunked, time-boxed) → per-store
//                 revenue snapshots, PLUS a PORTFOLIO subscriber-count refresh
//
// Window: 1st of LAST month → today (covers current + previous month).
// Phoenix is heavy (~5700 customers); it runs LAST and is time-boxed so the
// function returns within the Vercel budget even if Phoenix can't finish in
// one fire — the hourly cron keeps recent Phoenix counts fresh, and the next
// daily fire resumes the revenue walk via backfillRevenueForRange's cursor.
//
// Auth: Bearer $CRON_SECRET. ?secret= for manual runs. ?from=YYYY-MM-DD
// overrides the window start.

import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { backfillRange } from "@/lib/pnl/backfill";
import { hasStoreCreds } from "@/lib/shopify/stores";
import { syncPaysightDay } from "@/lib/paysight/sync";
import { getPaysightCreds, getSolvpathCreds } from "@/lib/integrations";
import {
  backfillRevenueForRange,
  SUBSCRIBER_STATUSES,
} from "@/lib/solvpath/sync";
import { listCustomers } from "@/lib/solvpath/client";
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Reserve the bulk of the wall budget for the heavy Phoenix revenue walk,
// but stop early enough to always return a response.
const TOTAL_BUDGET_MS = 760_000; // 760s; Vercel cap is 800s
const PHX_CHUNK_DEADLINE_MS = 55_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
/** First day of the PREVIOUS month (UTC) as YYYY-MM-DD. */
function firstOfPrevMonthUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based current month
  // prev month = m-1; Date handles the year rollover for January (m-1 = -1).
  return new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
}
function daysInRangeUtc(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return out;
}

async function refreshPhoenixCounts(tenantId: string) {
  const counts: Record<string, number> = {};
  for (const status of SUBSCRIBER_STATUSES) {
    const r = await listCustomers(tenantId, {
      Page: 1,
      Limit: 1,
      SubscriptionStatus: status,
    });
    counts[status] = r.TotalCount ?? 0;
  }
  const today = todayUtc();
  const sb = supabaseAdmin();
  await sb.from("phx_summary_snapshots").upsert(
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
      raw_json: { source: "cron.sync-daily-full", counts },
    },
    { onConflict: "tenant_id,store_id,range_from,range_to" },
  );
  return counts;
}

async function handle(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(req)) return unauthorized();

  const fromOverride = req.nextUrl.searchParams.get("from");
  const from =
    fromOverride && DATE_RE.test(fromOverride)
      ? fromOverride
      : firstOfPrevMonthUtc();
  const to = todayUtc();

  const started = Date.now();
  const sb = supabaseAdmin();
  const tenants = await listActiveTenants();

  const shopify: Array<Record<string, unknown>> = [];
  const paysight: Array<Record<string, unknown>> = [];
  const phoenix: Array<Record<string, unknown>> = [];
  let phoenixTimedOut = false;

  for (const tenant of tenants) {
    // ── 1. Shopify full range per store ──
    const { data: stores } = await sb
      .from("stores")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .neq("id", "PORTFOLIO")
      .neq("id", "__BACKFILL_DEDUPE__");
    for (const store of stores ?? []) {
      if (!(await hasStoreCreds(store.id, tenant.id))) continue;
      try {
        const res = await backfillRange(store.id, from, to, tenant.id);
        const orders = res.reduce((s, r) => s + r.pull.orderCount, 0);
        shopify.push({ store: store.id, days: res.length, orders, ok: true });
      } catch (err) {
        shopify.push({
          store: store.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 2. Paysight full range (per day) ──
    const pCreds = await getPaysightCreds(tenant.id);
    if (pCreds) {
      let subs = 0;
      let tx = 0;
      let failed = 0;
      for (const date of daysInRangeUtc(from, to)) {
        try {
          const r = await syncPaysightDay(tenant.id, date);
          subs += r.subscriptionsUpserted;
          tx += r.transactionsUpserted;
        } catch {
          failed++;
        }
      }
      paysight.push({ tenant: tenant.display_name, subs, tx, failed });
    }

    // ── 3. Phoenix: counts (fast) + revenue walk (heavy, time-boxed) ──
    const sCreds = await getSolvpathCreds(tenant.id);
    if (sCreds) {
      try {
        const counts = await refreshPhoenixCounts(tenant.id);
        phoenix.push({ tenant: tenant.display_name, counts, ok: true });
      } catch (err) {
        phoenix.push({
          tenant: tenant.display_name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Revenue walk — chunked. Resumes across daily fires via the cursor
      // that backfillRevenueForRange persists internally (seenCustomers).
      let startStatus:
        | "Active"
        | "Canceled"
        | "Never Enrolled"
        | undefined;
      let startPage: number | undefined;
      let chunks = 0;
      while (Date.now() - started < TOTAL_BUDGET_MS) {
        const result = await backfillRevenueForRange({
          tenantId: tenant.id,
          from,
          to,
          deadlineMs: PHX_CHUNK_DEADLINE_MS,
          startStatus,
          startPage,
        });
        chunks++;
        if (result.progress.finished) {
          phoenix.push({
            tenant: tenant.display_name,
            revenueWalk: "finished",
            chunks,
          });
          break;
        }
        startStatus = result.progress.nextStatus ?? undefined;
        startPage = result.progress.nextPage ?? undefined;
        if (Date.now() - started >= TOTAL_BUDGET_MS) {
          phoenixTimedOut = true;
          phoenix.push({
            tenant: tenant.display_name,
            revenueWalk: "time-boxed (resumes next daily fire)",
            chunks,
            nextStatus: startStatus,
            nextPage: startPage,
          });
          break;
        }
      }
    }
  }

  return Response.json({
    ok: true,
    mode: "daily-full-backfill",
    window: { from, to },
    phoenixTimedOut,
    ranAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    shopify,
    paysight,
    phoenix,
  });
}

export const GET = handle;
export const POST = handle;

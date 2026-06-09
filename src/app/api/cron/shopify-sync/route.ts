// Daily sync — triggered by Vercel cron (see vercel.json).
//
// For every active non-portfolio store:
//   1. Pull the LAST 3 DAYS of orders from Shopify (in the store's local
//      timezone) and re-sync each. We use a 3-day window (not 1) so that:
//        a) Yesterday's data is always finalized (the original target).
//        b) Day-before-yesterday catches any late refunds / cancellations
//           Shopify processed after our previous sync.
//        c) Today's partial data is captured so the dashboard isn't empty
//           when users log in, AND any cross-midnight boundary order that
//           was misfiled under yesterday during the previous run gets
//           corrected automatically.
//      The colon-quoting fix (see syncDailyOrders) prevents the
//      half-infinite-window bug that was inflating counts; the 3-day
//      window is the belt to that suspenders.
//   2. Recompute daily_pnl for each of those (store, date) rows.
// Then pulls the last 7 days of Chargeblast alerts — the 7-day window catches
// both brand-new alerts and status updates (won/lost) on recent alerts.
//
// Query params (optional):
//   - date=YYYY-MM-DD  → sync this exact date for every store (backfill;
//     overrides the 3-day window).
//   - days=N           → override the window size (default 3, max 30).
//
// Auth: Vercel cron includes an `Authorization: Bearer <CRON_SECRET>` header
// on every cron-triggered request. Middleware lets /api/cron/* through; this
// route enforces the secret itself. Pass ?secret= for manual triggers.

import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncDailyOrders } from "@/lib/shopify/sync";
import { computeDailyPnl } from "@/lib/pnl/compute";
import {
  hasStoreCreds,
  listConfiguredStores,
  describeConfiguredTokens,
} from "@/lib/shopify/stores";
import { syncAlerts } from "@/lib/chargeblast/sync";
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** "Today" in the given timezone, as YYYY-MM-DD. */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The last N days (today back to today-N+1) in tz, newest-first. */
function lastNDaysInTz(tz: string, n: number): string[] {
  const today = todayInTz(tz);
  const [y, m, d] = today.split("-").map(Number);
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    dates.push(dt.toISOString().slice(0, 10));
  }
  return dates;
}

async function handle(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed — no secret configured means the cron is effectively disabled.
    return Response.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }

  // Vercel's built-in cron sets Authorization: Bearer <secret>.
  // Allow a `?secret=` query-string for manual trigger during development.
  const auth = request.headers.get("authorization");
  const qsSecret = request.nextUrl.searchParams.get("secret");
  const ok =
    auth === `Bearer ${expected}` || (qsSecret && qsSecret === expected);
  if (!ok) return unauthorized();

  const sb = supabaseAdmin();

  // Iterate every active tenant — phase 1B's cron loop. Each tenant's stores
  // and Chargeblast alerts are pulled separately; tenant_id flows through.
  const tenants = await listActiveTenants();

  // Optional explicit date override for backfills: ?date=YYYY-MM-DD.
  const dateOverride = request.nextUrl.searchParams.get("date");
  const explicit =
    dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)
      ? dateOverride
      : null;

  // ?days=N — override the rolling window size (default 3, max 30).
  const daysParam = request.nextUrl.searchParams.get("days");
  const parsedDays = daysParam ? Number(daysParam) : NaN;
  const windowDays =
    Number.isFinite(parsedDays) && parsedDays > 0
      ? Math.min(30, Math.floor(parsedDays))
      : 3;

  const started = Date.now();
  const results: Array<Record<string, unknown>> = [];
  const skipped: Array<{ tenant: string; store: string }> = [];
  const chargeblastByTenant: Array<Record<string, unknown>> = [];

  for (const tenant of tenants) {
    const { data: stores, error: storesErr } = await sb
      .from("stores")
      .select("id, timezone, shop_domain")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .neq("id", "PORTFOLIO");
    if (storesErr) {
      results.push({ tenant: tenant.display_name, error: storesErr.message });
      continue;
    }
    for (const store of stores ?? []) {
      if (!(await hasStoreCreds(store.id, tenant.id))) {
        skipped.push({ tenant: tenant.display_name, store: store.id });
        continue;
      }
      // Either sync one explicit date (backfill mode) or a rolling window
      // of the last `windowDays` days. Loop is sequential per store so we
      // stay polite to Shopify's per-shop rate limit.
      const dates = explicit
        ? [explicit]
        : lastNDaysInTz(store.timezone ?? "UTC", windowDays);
      for (const date of dates) {
        try {
          const pull = await syncDailyOrders(store.id, date, tenant.id);
          const pnl = await computeDailyPnl(store.id, date, tenant.id);
          results.push({
            tenant: tenant.display_name,
            store: store.id,
            date,
            ok: true,
            orderCount: pull.orderCount,
            grossSales: pull.grossSales,
            netProfit: pnl?.net_profit ?? null,
          });
        } catch (err) {
          results.push({
            tenant: tenant.display_name,
            store: store.id,
            date,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Chargeblast pull — last 7 days so status updates on older alerts flow in.
    // Skip the tenant entirely when they have no stores with a Chargeblast
    // descriptor — otherwise we'd write the global alert feed (one shared
    // CHARGEBLAST_API_KEY across all tenants) into tenants that don't own
    // the merchant account, polluting their data.
    if (process.env.CHARGEBLAST_API_KEY) {
      const { count: descriptorCount } = await sb
        .from("stores")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id)
        .not("chargeblast_descriptor", "is", null);
      if (!descriptorCount) {
        chargeblastByTenant.push({
          tenant: tenant.display_name,
          ok: true,
          skipped: "no chargeblast_descriptor on any store",
        });
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
        try {
          const r = await syncAlerts(tenant.id, {
            start_date: weekAgo,
            end_date: today,
          });
          chargeblastByTenant.push({
            tenant: tenant.display_name,
            ok: true,
            ...r,
          });
        } catch (err) {
          chargeblastByTenant.push({
            tenant: tenant.display_name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  if (!process.env.CHARGEBLAST_API_KEY) {
    chargeblastByTenant.push({ ok: false, error: "CHARGEBLAST_API_KEY not set" });
  }

  return Response.json({
    ok: true,
    ranAt: new Date().toISOString(),
    mode: explicit ? "backfill" : `rolling-${windowDays}d`,
    elapsedMs: Date.now() - started,
    skipped,
    configuredInEnv: listConfiguredStores(),
    tokenShapes: describeConfiguredTokens(),
    results,
    chargeblast: chargeblastByTenant,
    tenants: tenants.map((t) => t.display_name),
  });
}

export const GET = handle;
export const POST = handle;

// Daily Paysight sync — Vercel cron.
//
// Pulls the last 3 days of subscriptions + transactions for every active
// tenant into the paysight_* tables. The 3-day rolling window (today +
// yesterday + day-before) self-corrects late refunds, captured-later
// transactions, and cross-midnight boundary rows — same hardening pattern
// as the Shopify cron.
//
// Auth: Bearer $CRON_SECRET (Vercel cron sets this header). Accepts
// ?secret=<CRON_SECRET> for manual triggers. ?days=N overrides the window
// (default 3, max 7 — the transaction API caps broad searches at 7 days).

import { NextRequest } from "next/server";
import { getPaysightCreds } from "@/lib/integrations";
import { syncPaysightDay } from "@/lib/paysight/sync";
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
  const header = req.headers.get("authorization");
  const qs = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${expected}` || qs === expected;
}

/** Last N days (today back to today-N+1) as YYYY-MM-DD, newest first. */
function lastNDaysUtc(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
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
  const dates = lastNDaysUtc(windowDays);

  const started = Date.now();
  const tenants = await listActiveTenants();
  const results: Array<Record<string, unknown>> = [];

  for (const tenant of tenants) {
    // Skip tenants without Paysight creds so the cron stays quiet for
    // workspaces that don't use Paysight.
    const creds = await getPaysightCreds(tenant.id);
    if (!creds) {
      results.push({ tenant: tenant.display_name, skipped: "no paysight creds" });
      continue;
    }
    for (const date of dates) {
      try {
        const r = await syncPaysightDay(tenant.id, date);
        results.push({
          tenant: tenant.display_name,
          date,
          ok: true,
          subscriptionsUpserted: r.subscriptionsUpserted,
          transactionsUpserted: r.transactionsUpserted,
        });
      } catch (err) {
        results.push({
          tenant: tenant.display_name,
          date,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return Response.json({
    ok: true,
    ranAt: new Date().toISOString(),
    windowDays,
    dates,
    elapsedMs: Date.now() - started,
    results,
  });
}

export const GET = handle;
export const POST = handle;

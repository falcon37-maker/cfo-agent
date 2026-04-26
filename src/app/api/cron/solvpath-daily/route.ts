// Daily Solvpath sync. Pulls yesterday's PHX subscription data for NOVA /
// NURA / KOVA so the dashboard always shows fresh Subs Billed + Subs Rev.
//
// Single pass with an internal deadline well under Vercel's 800s cap.
// backfillRevenueForRange checks its deadline between customer iterations, so
// it exits cleanly even if Solvpath is slow. If the day doesn't finish in
// one pass, the response carries a resume cursor and a human re-runs with
// ?startStatus=&startPage= to finish.

import { NextRequest } from "next/server";
import { backfillRevenueForRange } from "@/lib/solvpath/sync";
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const DEADLINE_MS = 700_000; // 700s — leaves ~100s for response + persistence

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

/** Yesterday in UTC, YYYY-MM-DD. */
function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function handle(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  if (!authorized(req)) return unauthorized();

  const missing = [
    "SOLVPATH_PARTNER_ID",
    "SOLVPATH_PARTNER_TOKEN",
    "SOLVPATH_BEARER_TOKEN",
  ].filter((k) => !process.env[k]);
  if (missing.length) {
    return Response.json(
      { error: `Solvpath env not configured: ${missing.join(", ")}` },
      { status: 503 },
    );
  }

  // ?date=YYYY-MM-DD overrides the default "yesterday" — handy for backfilling
  // a missed day from a manual trigger.
  const dateOverride = req.nextUrl.searchParams.get("date");
  const day =
    dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)
      ? dateOverride
      : yesterdayUtc();

  // Resume cursor — only used when a previous run got cut off mid-day.
  const startStatusRaw = req.nextUrl.searchParams.get("startStatus");
  const startPageRaw = req.nextUrl.searchParams.get("startPage");
  const startStatus =
    startStatusRaw === "Active" ||
    startStatusRaw === "Canceled" ||
    startStatusRaw === "Never Enrolled"
      ? startStatusRaw
      : undefined;
  const startPage = startPageRaw ? Number(startPageRaw) : undefined;

  const startedAt = Date.now();
  const tenants = await listActiveTenants();
  // Split the deadline budget across tenants so a single slow tenant can't
  // starve the others. With one tenant today we just hand it the full
  // DEADLINE_MS; with N we divide.
  const perTenantDeadline =
    tenants.length > 0 ? Math.floor(DEADLINE_MS / tenants.length) : DEADLINE_MS;

  const tenantResults: Array<Record<string, unknown>> = [];
  for (const tenant of tenants) {
    try {
      const r = await backfillRevenueForRange({
        tenantId: tenant.id,
        from: day,
        to: day,
        startStatus,
        startPage,
        reset: !startStatus && !startPage,
        maxCustomers: 50_000,
        throttleMs: 75,
        deadlineMs: perTenantDeadline,
        persist: true,
      });
      const p = r.progress;
      tenantResults.push({
        tenant: tenant.display_name,
        finished: p.finished,
        customersSeen: p.customersSeen,
        customersWithTx: p.customersWithTx,
        customersSkippedDup: p.customersSkippedDup,
        perStoreTotals: r.perStoreTotals,
        nextStatus: p.nextStatus,
        nextPage: p.nextPage,
      });
    } catch (err) {
      tenantResults.push({
        tenant: tenant.display_name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    ok: true,
    ranAt: new Date().toISOString(),
    day,
    elapsedMs: Date.now() - startedAt,
    tenantResults,
  });
}

export const GET = handle;
export const POST = handle;

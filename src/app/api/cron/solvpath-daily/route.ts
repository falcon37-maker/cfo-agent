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
  const result = await backfillRevenueForRange({
    from: day,
    to: day,
    startStatus,
    startPage,
    // Reset (= delete existing rows for this day) only on a fresh run, not
    // when a human is resuming via cursor — otherwise we'd wipe progress.
    reset: !startStatus && !startPage,
    // The exported default is 500 customers per chunk; we want one big pass
    // to process the full ~3500-customer base in a single invocation.
    maxCustomers: 50_000,
    throttleMs: 75,
    deadlineMs: DEADLINE_MS,
    persist: true,
  });

  const p = result.progress;
  return Response.json({
    ok: true,
    ranAt: new Date().toISOString(),
    day,
    finished: p.finished,
    elapsedMs: Date.now() - startedAt,
    customersSeen: p.customersSeen,
    customersWithTx: p.customersWithTx,
    customersSkippedDup: p.customersSkippedDup,
    perStoreTotals: result.perStoreTotals,
    nextStatus: p.nextStatus,
    nextPage: p.nextPage,
  });
}

export const GET = handle;
export const POST = handle;

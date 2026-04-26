// Daily Solvpath sync. Pulls yesterday's PHX subscription data for NOVA /
// NURA / KOVA so the dashboard always shows fresh Subs Billed + Subs Rev.
//
// Triggered by Vercel cron at 08:30 UTC daily (see vercel.json), and also
// hand-runnable via ?secret=$CRON_SECRET. Loops backfillRevenueForRange in
// chunks until finished or until we've burned ~12 minutes — Vercel's Pro
// plan caps this route at 800s, so we keep ~80s headroom under that.
//
// The yesterday window is small enough (one day's tx-history per customer)
// that 3500-ish customers usually finish well inside the cap, but the
// resumable cursor is here as insurance against transient slowness.

import { NextRequest } from "next/server";
import {
  backfillRevenueForRange,
  type SubscriberStatus,
} from "@/lib/solvpath/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MAX_CHUNK_DEADLINE_MS = 180_000; // 3 min per chunk
const MAX_TOTAL_MS = 720_000; // 12 min wall budget for the loop
const MAX_CHUNKS = 40;

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

  const startedAt = Date.now();
  const chunks: Array<{
    chunk: number;
    elapsedMs: number;
    customersSeen: number;
    finished: boolean;
    nextStatus: SubscriberStatus | null;
    nextPage: number | null;
  }> = [];

  let nextStatus: SubscriberStatus | undefined;
  let nextPage: number | undefined;
  let totalCustomers = 0;
  let totalCustomersWithTx = 0;

  for (let i = 0; i < MAX_CHUNKS; i++) {
    if (Date.now() - startedAt > MAX_TOTAL_MS) break;
    const chunkStart = Date.now();
    const result = await backfillRevenueForRange({
      from: day,
      to: day,
      startStatus: nextStatus,
      startPage: nextPage,
      // Reset the (store, day) snapshots only on the first chunk so we don't
      // wipe progress mid-loop. After the reset, subsequent chunks merge
      // additively into what we just wrote.
      reset: i === 0,
      throttleMs: 100,
      deadlineMs: MAX_CHUNK_DEADLINE_MS,
      persist: true,
    });
    const p = result.progress;
    chunks.push({
      chunk: i + 1,
      elapsedMs: Date.now() - chunkStart,
      customersSeen: p.customersSeen,
      finished: p.finished,
      nextStatus: p.nextStatus,
      nextPage: p.nextPage,
    });
    totalCustomers += p.customersSeen;
    totalCustomersWithTx += p.customersWithTx;
    if (p.finished) break;
    if (p.nextStatus == null || p.nextPage == null) {
      // Defensive: if the chunk reported "not finished" but didn't return a
      // cursor, bail rather than loop forever.
      break;
    }
    nextStatus = p.nextStatus;
    nextPage = p.nextPage;
  }

  const finished = chunks[chunks.length - 1]?.finished ?? false;
  return Response.json({
    ok: true,
    ranAt: new Date().toISOString(),
    day,
    finished,
    elapsedMs: Date.now() - startedAt,
    totalCustomers,
    totalCustomersWithTx,
    chunkCount: chunks.length,
    chunks,
  });
}

export const GET = handle;
export const POST = handle;

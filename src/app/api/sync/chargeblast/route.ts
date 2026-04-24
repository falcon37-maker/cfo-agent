// Chargeblast sync endpoint.
//   - ?action=ping      — verify API key
//   - ?action=backfill  — pull all alerts (optionally within date range)
//                         and upsert into chargeblast_alerts
//
// Auth: same Bearer $CRON_SECRET pattern as the Solvpath + Shopify syncs.

import { NextRequest } from "next/server";
import { ping } from "@/lib/chargeblast/client";
import { syncAlerts } from "@/lib/chargeblast/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

async function handle(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(req)) return unauthorized();
  if (!process.env.CHARGEBLAST_API_KEY) {
    return Response.json(
      { error: "CHARGEBLAST_API_KEY not set" },
      { status: 503 },
    );
  }

  const action = req.nextUrl.searchParams.get("action") ?? "ping";

  try {
    if (action === "ping") {
      const p = await ping();
      return Response.json({ ok: true, action, total: p.total, sample: p.sample });
    }

    if (action === "backfill") {
      const from = req.nextUrl.searchParams.get("from") ?? undefined;
      const to = req.nextUrl.searchParams.get("to") ?? undefined;
      const status = req.nextUrl.searchParams.get("status") ?? undefined;
      const started = Date.now();
      const result = await syncAlerts({
        start_date: from,
        end_date: to,
        status,
      });
      return Response.json({
        ok: true,
        action,
        from,
        to,
        status,
        elapsedMs: Date.now() - started,
        ...result,
      });
    }

    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;

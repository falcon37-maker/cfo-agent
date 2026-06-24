// Cohort-charge backfill — pulls Phoenix per-charge history into
// phx_cohort_charges for cohort-based churn. Auth: Bearer $CRON_SECRET or
// ?secret=. Window via ?from=&to= (defaults to last 150 days).
//
// Heavy (one bulk pull per day); time-boxed so it returns within budget and
// can be re-run to continue. Idempotent (upsert on order_id).

import { NextRequest } from "next/server";
import { syncPhxCohortDay } from "@/lib/phx-cohort/sync";
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUDGET_MS = 760_000;

function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const h = req.headers.get("authorization");
  const q = req.nextUrl.searchParams.get("secret");
  return h === `Bearer ${expected}` || q === expected;
}

function daysInRange(from: string, to: string): string[] {
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

async function handle(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const to = DATE_RE.test(sp.get("to") || "") ? sp.get("to")! : today;
  const from = DATE_RE.test(sp.get("from") || "")
    ? sp.get("from")!
    : new Date(Date.now() - 150 * 86_400_000).toISOString().slice(0, 10);

  const started = Date.now();
  const tenants = await listActiveTenants();
  const results: Array<Record<string, unknown>> = [];
  let timedOut = false;

  for (const tenant of tenants) {
    let approved = 0;
    let declined = 0;
    let failed = 0;
    let lastDay: string | null = null;
    for (const day of daysInRange(from, to)) {
      if (Date.now() - started >= BUDGET_MS) {
        timedOut = true;
        break;
      }
      try {
        const r = await syncPhxCohortDay(tenant.id, day);
        approved += r.approved;
        declined += r.declined;
        lastDay = day;
      } catch {
        failed++;
      }
    }
    results.push({
      tenant: tenant.display_name,
      approved,
      declined,
      failed,
      lastDay,
    });
    if (timedOut) break;
  }

  return Response.json({
    ok: true,
    window: { from, to },
    timedOut,
    elapsedMs: Date.now() - started,
    results,
  });
}

export const GET = handle;
export const POST = handle;

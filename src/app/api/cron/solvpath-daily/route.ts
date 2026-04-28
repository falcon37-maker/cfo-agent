// Daily Solvpath sync — one Vercel invocation = one long internal loop.
//
// This is the SAME logic /api/sync/solvpath?action=backfill exposes
// (drove the Jan-Apr 23 backfill successfully); we just call it
// repeatedly from inside one cron-fired function until either the day
// is finished OR our 750s wall budget runs out. No self-retrigger via
// fetch — that turned out unreliable on Vercel and broke trust in the
// daily fire.
//
// vercel.json schedules this route every hour from 08:00–14:00 UTC,
// so even if a single ~800s invocation can't cover a full ~3500-
// customer day on its own, the next hour's fire picks up where the
// previous left off (via the persisted dedupe marker — see
// loadSeenCustomers / persistSeenCustomers in src/lib/solvpath/sync).

import { NextRequest } from "next/server";
import { backfillRevenueForRange } from "@/lib/solvpath/sync";
import { listActiveTenants, type Tenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// One chunk = up to 500 customers in up to ~40s (sync.ts default
// deadlineMs). Loop budget leaves headroom for the response + Supabase
// writes after the last chunk.
const CHUNK_DEADLINE_MS = 40_000;
const CHUNK_MAX_CUSTOMERS = 500;
const TOTAL_BUDGET_MS = 750_000; // 750s; Vercel cap is 800s

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

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Active tenants that own at least one store with a Solvpath store code. */
async function listPhxTenants(): Promise<Tenant[]> {
  const all = await listActiveTenants();
  if (all.length === 0) return [];
  const sb = supabaseAdmin();
  const out: Tenant[] = [];
  for (const t of all) {
    const { count } = await sb
      .from("stores")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", t.id)
      .eq("is_active", true)
      .not("solvpath_store_code", "is", null);
    if (count && count > 0) out.push(t);
  }
  return out;
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

  const sp = req.nextUrl.searchParams;
  const dateOverride = sp.get("date");
  const day =
    dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)
      ? dateOverride
      : yesterdayUtc();

  const tenants = await listPhxTenants();
  if (tenants.length === 0) {
    return Response.json({
      ok: true,
      day,
      message: "no PHX-tenant stores configured — nothing to sync",
    });
  }

  const startedAt = Date.now();
  const tenantResults: Array<Record<string, unknown>> = [];

  // Process tenants serially. Within each tenant, loop chunks until that
  // tenant's day is finished or our wall budget runs out. backfillRevenue-
  // ForRange handles cursor + dedupe internally, so each iteration just
  // hands it the previous response's cursor.
  for (const tenant of tenants) {
    if (Date.now() - startedAt >= TOTAL_BUDGET_MS) break;

    let chunks = 0;
    let totalSeen = 0;
    let totalWithTx = 0;
    let lastNextStatus: string | null = null;
    let lastNextPage: number | null = null;
    let finished = false;
    // First chunk for this tenant on this day's fire is allowed to start
    // from the top — backfillRevenueForRange's seenCustomers load makes
    // it cheap to re-walk past previously processed customers.
    let startStatus: "Active" | "Canceled" | "Never Enrolled" | undefined;
    let startPage: number | undefined;

    while (Date.now() - startedAt < TOTAL_BUDGET_MS) {
      const result = await backfillRevenueForRange({
        tenantId: tenant.id,
        from: day,
        to: day,
        startStatus,
        startPage,
        // Reset is opt-in via ?reset=1 only — daily fires must not wipe
        // accumulated progress.
        reset: false,
        maxCustomers: CHUNK_MAX_CUSTOMERS,
        throttleMs: 75,
        deadlineMs: CHUNK_DEADLINE_MS,
        persist: true,
      });
      const p = result.progress;
      chunks += 1;
      totalSeen += p.customersSeen;
      totalWithTx += p.customersWithTx;
      lastNextStatus = p.nextStatus;
      lastNextPage = p.nextPage;
      if (p.finished) {
        finished = true;
        break;
      }
      if (p.nextStatus == null || p.nextPage == null) break;
      startStatus = p.nextStatus;
      startPage = p.nextPage;
    }

    tenantResults.push({
      tenant: tenant.display_name,
      finished,
      chunks,
      customersSeen: totalSeen,
      customersWithTx: totalWithTx,
      nextStatus: finished ? null : lastNextStatus,
      nextPage: finished ? null : lastNextPage,
    });
  }

  return Response.json({
    ok: true,
    day,
    elapsedMs: Date.now() - startedAt,
    tenantResults,
  });
}

export const GET = handle;
export const POST = handle;

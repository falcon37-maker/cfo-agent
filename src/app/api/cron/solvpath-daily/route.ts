// Daily Solvpath sync — chunked.
//
// One Vercel invocation = one 500-customer chunk (~45s). After the chunk,
// the route fires-and-forgets a fetch back to itself with the cursor in the
// URL. Next invocation gets its own 800s budget. Repeat until the day is
// finished, then advance to the next tenant. This dodges Vercel's hard
// per-function cap.
//
// Triggers:
//   - Vercel cron at 08:30 UTC (no params): runs yesterday across all
//     tenants that have PHX stores.
//   - Manual:
//       /api/cron/solvpath-daily?date=YYYY-MM-DD&secret=$CRON_SECRET
//     Runs that day across every PHX tenant.
//
// Self-retrigger params (set by the route, not by the user):
//   - tenantId    — UUID of the tenant being chunked
//   - startStatus — Solvpath subscription status to resume from
//   - startPage   — page within that status to resume from
//
// Response is per-chunk: progress, where the next chunk landed (or
// "complete"), so the cron driver can see what's happening if it polls.

import { NextRequest } from "next/server";
import { backfillRevenueForRange } from "@/lib/solvpath/sync";
import { listActiveTenants, type Tenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const CHUNK_DEADLINE_MS = 60_000; // single chunk wall budget — fits inside 800s
const CHUNK_MAX_CUSTOMERS = 500; // matches the existing chunked-backfill default

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

function buildSelfUrl(
  req: NextRequest,
  params: Record<string, string | number | undefined | null>,
): string {
  const u = new URL(req.url);
  // Reset query string then re-attach the secret + the new params.
  const secret = u.searchParams.get("secret");
  u.search = "";
  if (secret) u.searchParams.set("secret", secret);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function scheduleNext(req: NextRequest, nextUrl: string) {
  const headers: Record<string, string> = {};
  const auth = req.headers.get("authorization");
  if (auth) headers["authorization"] = auth;
  // Fire-and-forget. We give it ~250ms before letting the response return,
  // long enough for the TCP connection to start and Vercel to register
  // the outbound request, but short enough that the cron driver still sees
  // a fast response. We don't await the fetch to completion — the next
  // invocation has its own 800s budget.
  void fetch(nextUrl, { method: "POST", headers }).catch((err) => {
    console.error("[solvpath-daily] re-trigger failed:", err);
  });
  await new Promise((r) => setTimeout(r, 250));
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

  const cursorTenantId = sp.get("tenantId");
  const cursorStartStatus = sp.get("startStatus");
  const cursorStartPageRaw = sp.get("startPage");
  const cursorStartPage = cursorStartPageRaw
    ? Number(cursorStartPageRaw)
    : undefined;

  const tenants = await listPhxTenants();
  if (tenants.length === 0) {
    return Response.json({
      ok: true,
      day,
      message: "no PHX-tenant stores configured — nothing to sync",
    });
  }

  // Resolve which tenant to run this chunk against. If no cursor: first
  // PHX tenant. If cursor present: continue that tenant (fresh chunk in
  // the middle of a day).
  let tenant: Tenant | undefined;
  let isFirstChunkForTenant = false;
  if (cursorTenantId) {
    tenant = tenants.find((t) => t.id === cursorTenantId);
    if (!tenant) {
      return Response.json(
        {
          ok: false,
          error: `cursor tenantId ${cursorTenantId} not in active PHX tenants`,
        },
        { status: 400 },
      );
    }
    isFirstChunkForTenant = !cursorStartStatus && !cursorStartPage;
  } else {
    tenant = tenants[0];
    isFirstChunkForTenant = true;
  }

  const startedAt = Date.now();
  const validStatuses = ["Active", "Canceled", "Never Enrolled"] as const;
  const startStatus =
    cursorStartStatus &&
    (validStatuses as readonly string[]).includes(cursorStartStatus)
      ? (cursorStartStatus as (typeof validStatuses)[number])
      : undefined;

  const result = await backfillRevenueForRange({
    tenantId: tenant.id,
    from: day,
    to: day,
    startStatus,
    startPage: cursorStartPage,
    // Reset only on the FIRST chunk of the FIRST tenant for this date —
    // i.e. when the user / cron called us with no cursor at all. Otherwise
    // we'd wipe progress mid-loop.
    reset: isFirstChunkForTenant,
    maxCustomers: CHUNK_MAX_CUSTOMERS,
    throttleMs: 75,
    deadlineMs: CHUNK_DEADLINE_MS,
    persist: true,
  });

  const p = result.progress;
  const elapsedMs = Date.now() - startedAt;

  let nextStep: "same-tenant" | "next-tenant" | "complete";
  let scheduled: string | null = null;
  if (!p.finished) {
    nextStep = "same-tenant";
    const url = buildSelfUrl(req, {
      date: day,
      tenantId: tenant.id,
      startStatus: p.nextStatus,
      startPage: p.nextPage,
    });
    await scheduleNext(req, url);
    scheduled = url;
  } else {
    const idx = tenants.findIndex((t) => t.id === tenant.id);
    const nextTenant = tenants[idx + 1];
    if (nextTenant) {
      nextStep = "next-tenant";
      const url = buildSelfUrl(req, { date: day, tenantId: nextTenant.id });
      await scheduleNext(req, url);
      scheduled = url;
    } else {
      nextStep = "complete";
    }
  }

  return Response.json({
    ok: true,
    day,
    tenant: tenant.display_name,
    chunk: {
      elapsedMs,
      finished: p.finished,
      customersSeen: p.customersSeen,
      customersWithTx: p.customersWithTx,
      customersSkippedDup: p.customersSkippedDup,
      nextStatus: p.nextStatus,
      nextPage: p.nextPage,
    },
    perStoreTotals: result.perStoreTotals,
    nextStep,
    scheduledNext: scheduled,
  });
}

export const GET = handle;
export const POST = handle;

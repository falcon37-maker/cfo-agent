// Chargeblast sync endpoint.
//   - ?action=ping      — verify API key
//   - ?action=backfill  — pull all alerts (optionally within date range)
//                         and upsert into chargeblast_alerts
//
// Auth: same Bearer $CRON_SECRET pattern as the Solvpath + Shopify syncs.

import { NextRequest } from "next/server";
import { ping } from "@/lib/chargeblast/client";
import { syncAlerts } from "@/lib/chargeblast/sync";
import { listActiveTenants } from "@/lib/tenant";

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
      // Resolve tenant the same way as the backfill action below
      const explicitTenantId = req.nextUrl.searchParams.get("tenantId");
      let tenantId = explicitTenantId ?? null;
      if (!tenantId) {
        const tenants = await listActiveTenants();
        if (tenants.length === 1) tenantId = tenants[0].id;
        else
          return Response.json(
            {
              error:
                "Multiple active tenants — pass ?tenantId=<uuid> to disambiguate.",
            },
            { status: 400 },
          );
      }
      const p = await ping(tenantId);
      return Response.json({ ok: true, action, tenantId, total: p.total, sample: p.sample });
    }

    if (action === "backfill") {
      const from = req.nextUrl.searchParams.get("from") ?? undefined;
      const to = req.nextUrl.searchParams.get("to") ?? undefined;
      const status = req.nextUrl.searchParams.get("status") ?? undefined;

      // CRON_SECRET-authed route — no user session, so resolve tenant via
      // ?tenantId= or fall back to the only active tenant. Errors when there
      // are multiple tenants and the caller didn't specify which.
      const explicitTenantId = req.nextUrl.searchParams.get("tenantId");
      let tenantId = explicitTenantId ?? null;
      if (!tenantId) {
        const tenants = await listActiveTenants();
        if (tenants.length === 1) tenantId = tenants[0].id;
        else
          return Response.json(
            {
              error:
                "Multiple active tenants — pass ?tenantId=<uuid> to disambiguate.",
              tenants: tenants.map((t) => ({
                id: t.id,
                name: t.display_name,
              })),
            },
            { status: 400 },
          );
      }

      const started = Date.now();
      const result = await syncAlerts(tenantId, {
        start_date: from,
        end_date: to,
        status,
      });
      return Response.json({
        ok: true,
        action,
        tenantId,
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

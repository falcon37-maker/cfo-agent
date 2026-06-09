// Phase 2 — daily data validation cron.
//
// Runs all checks in src/lib/validation/daily-checks.ts for every active
// tenant and persists results into data_validation_log. The dashboard
// reads open rows to show a "⚠ N data issues" banner.
//
// Fires daily after the Shopify + Solvpath crons so it inspects the
// freshest data. Manual trigger via ?secret=… for ad-hoc runs.

import { NextRequest } from "next/server";
import { listActiveTenants } from "@/lib/tenant";
import { runAllChecks, persistChecks } from "@/lib/validation/daily-checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  const qsSecret = req.nextUrl.searchParams.get("secret");
  const ok =
    auth === `Bearer ${expected}` || (qsSecret && qsSecret === expected);
  if (!ok) return unauthorized();

  const explicitTenantId = req.nextUrl.searchParams.get("tenantId");
  const tenants = explicitTenantId
    ? (await listActiveTenants()).filter((t) => t.id === explicitTenantId)
    : await listActiveTenants();

  const startedAt = Date.now();
  const results: Array<{
    tenantId: string;
    tenantName: string;
    issuesFound: number;
    inserted: number;
    closed: number;
    error?: string;
  }> = [];

  for (const t of tenants) {
    try {
      const issues = await runAllChecks(t.id);
      const { inserted, closed } = await persistChecks(t.id, issues);
      results.push({
        tenantId: t.id,
        tenantName: t.display_name,
        issuesFound: issues.length,
        inserted,
        closed,
      });
    } catch (e) {
      results.push({
        tenantId: t.id,
        tenantName: t.display_name,
        issuesFound: 0,
        inserted: 0,
        closed: 0,
        error: (e as Error).message,
      });
    }
  }

  return Response.json({
    ok: true,
    elapsedMs: Date.now() - startedAt,
    tenantsProcessed: results.length,
    results,
  });
}

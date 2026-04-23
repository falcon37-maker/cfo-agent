// Solvpath → phx_summary_snapshots sync endpoint.
//
// Auth: Bearer $CRON_SECRET (same as the Shopify cron). Middleware whitelists
// /api/sync/solvpath/* since the secret is enforced here.
//
// Modes:
//   GET ?action=ping              — sanity-check: list stores, dump the first
//                                   few. Exercises the Solvpath auth header
//                                   without touching any customer data.
//   GET ?action=backfill&from=&to=  — iterate customers + transactions for
//                                   [from, to], upsert into phx_summary_snapshots.
//
// Both accept ?secret=<CRON_SECRET> for manual triggers.

import { NextRequest } from "next/server";
import { listStores } from "@/lib/solvpath/client";
import { backfillRevenueForRange } from "@/lib/solvpath/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600; // long-running customer iteration

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = request.headers.get("authorization");
  const qs = request.nextUrl.searchParams.get("secret");
  return header === `Bearer ${expected}` || qs === expected;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handle(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(request)) return unauthorized();

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

  const action = request.nextUrl.searchParams.get("action") ?? "ping";

  try {
    if (action === "ping") {
      const stores = await listStores({ Limit: 25, Page: 1 });
      return Response.json({
        ok: true,
        action,
        totalCount: stores.TotalCount,
        sample: (stores.Result ?? []).slice(0, 10).map((s) => ({
          StoreCode: s.StoreCode,
          Title: s.Title,
          DomainUrl: s.DomainUrl,
          Type: s.Type,
        })),
      });
    }

    if (action === "backfill") {
      const from = request.nextUrl.searchParams.get("from") ?? "";
      const to = request.nextUrl.searchParams.get("to") ?? "";
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        return Response.json(
          { error: "from + to required (YYYY-MM-DD)" },
          { status: 400 },
        );
      }
      const limitParam = request.nextUrl.searchParams.get("customerLimit");
      const customerLimit = limitParam ? Number(limitParam) : undefined;

      const started = Date.now();
      const result = await backfillRevenueForRange({
        from,
        to,
        customerLimit: Number.isFinite(customerLimit ?? NaN)
          ? customerLimit
          : undefined,
        persist: request.nextUrl.searchParams.get("dryRun") !== "1",
      });
      return Response.json({
        ok: true,
        action,
        from,
        to,
        elapsedMs: Date.now() - started,
        result,
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

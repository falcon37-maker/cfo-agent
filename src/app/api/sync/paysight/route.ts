// Paysight sync endpoint.
//
// Auth: Bearer $CRON_SECRET (same as Shopify/Solvpath crons). Accepts
// ?secret=<CRON_SECRET> for manual triggers.
//
// Modes:
//   GET ?action=ping              — sanity check: pull page 1 of today's
//                                   subscriptions (proves creds + connectivity).
//   GET ?action=sync&date=YYYY-MM-DD
//                                 — sync subscriptions + transactions for one
//                                   day into paysight_* tables. Defaults to
//                                   yesterday if no date is given.
//   GET ?action=sync&from=YYYY-MM-DD&to=YYYY-MM-DD
//                                 — sync a transaction window (≤ 7 days) plus
//                                   subscriptions for each day in the range.

import { NextRequest } from "next/server";
import { searchSubscriptions } from "@/lib/paysight/client";
import {
  syncPaysightDay,
  syncSubscriptionsForDay,
  syncTransactionsForRange,
} from "@/lib/paysight/sync";
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization");
  const qs = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${expected}` || qs === expected;
}

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD dates from..to (caller bounds the size). */
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

async function resolveTenantId(req: NextRequest): Promise<string | Response> {
  const explicit = req.nextUrl.searchParams.get("tenantId");
  if (explicit) return explicit;
  const tenants = await listActiveTenants();
  if (tenants.length === 1) return tenants[0].id;
  return Response.json(
    {
      error: "Multiple active tenants — pass ?tenantId=<uuid>.",
      tenants: tenants.map((t) => ({ id: t.id, name: t.display_name })),
    },
    { status: 400 },
  );
}

async function handle(req: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!authorized(req)) return unauthorized();

  const tenantOrResp = await resolveTenantId(req);
  if (tenantOrResp instanceof Response) return tenantOrResp;
  const tenantId = tenantOrResp;

  // Default to "ping", but if any sync window param is present the caller
  // clearly meant to sync — don't silently no-op into a ping (HTTP 200 that
  // looks successful but writes nothing).
  const hasWindow =
    req.nextUrl.searchParams.has("from") ||
    req.nextUrl.searchParams.has("to") ||
    req.nextUrl.searchParams.has("date");
  const action =
    req.nextUrl.searchParams.get("action") ?? (hasWindow ? "sync" : "ping");

  try {
    if (action === "ping") {
      const date = todayUtc();
      const resp = await searchSubscriptions(tenantId, {
        pageNumber: 1,
        limit: 5,
        dateFrom: date,
        dateTo: date,
      });
      return Response.json({
        ok: true,
        action,
        date,
        count: resp.count,
        moreResults: resp.moreResults,
        sample: (resp.subscriptions ?? []).slice(0, 5).map((s) => ({
          id: s.id,
          descriptor: s.descriptor,
          email: s.email,
          active: s.active,
          subDate: s.subDate,
        })),
      });
    }

    if (action === "sync") {
      const from = req.nextUrl.searchParams.get("from");
      const to = req.nextUrl.searchParams.get("to");
      const single = req.nextUrl.searchParams.get("date");

      const started = Date.now();

      if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
        const days = daysInRange(from, to);
        if (days.length > 7) {
          return Response.json(
            { error: "range too wide — max 7 days per sync call" },
            { status: 400 },
          );
        }
        // Transactions: one ≤7-day window. Subscriptions: per day (1-day cap).
        const transactionsUpserted = await syncTransactionsForRange(
          tenantId,
          from,
          to,
        );
        let subscriptionsUpserted = 0;
        for (const d of days) {
          subscriptionsUpserted += await syncSubscriptionsForDay(tenantId, d);
        }
        return Response.json({
          ok: true,
          action,
          from,
          to,
          subscriptionsUpserted,
          transactionsUpserted,
          elapsedMs: Date.now() - started,
        });
      }

      const date =
        single && DATE_RE.test(single) ? single : yesterdayUtc();
      const result = await syncPaysightDay(tenantId, date);
      return Response.json({
        ok: true,
        action,
        ...result,
        elapsedMs: Date.now() - started,
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

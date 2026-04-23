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
import {
  getTransactionHistory,
  iterateCustomers,
  listStores,
} from "@/lib/solvpath/client";
import {
  backfillRevenueForRange,
  classifyTransaction,
  storeFromDomain,
  SUBSCRIBER_STATUSES,
  type SubscriberStatus,
} from "@/lib/solvpath/sync";

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

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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

    if (action === "smoke") {
      // Pull a single customer's transaction history so we can eyeball the
      // raw transaction shape + verify our classifier + domain mapping.
      const customerIdParam = request.nextUrl.searchParams.get("customerId");
      let customerId = customerIdParam ? Number(customerIdParam) : null;
      if (!customerId) {
        // Grab the first customer from the first non-empty status page.
        for (const status of ["Active", "Cancelled", "Paused"]) {
          for await (const c of iterateCustomers(status, 25)) {
            customerId = c.CustomerId;
            break;
          }
          if (customerId) break;
        }
      }
      if (!customerId) {
        return Response.json({ ok: false, error: "no customers returned" }, { status: 502 });
      }
      const startDate =
        request.nextUrl.searchParams.get("from") ?? "2026-04-01";
      const history = await getTransactionHistory(customerId, startDate);
      const rows = history.Result ?? [];
      const annotated = rows.slice(0, 20).map((tx) => ({
        date: tx.Date,
        domain: tx.Domain,
        store: storeFromDomain(tx.Domain),
        type: tx.Type,
        transactionType: tx.TransactionType,
        amount: tx.Amount,
        responseCode: tx.ResponseCode,
        recurringOrderCount: tx.RecurringOrderCount,
        classified: classifyTransaction(tx),
      }));
      return Response.json({
        ok: true,
        action,
        customerId,
        startDate,
        totalTx: rows.length,
        sample: annotated,
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
      const sp = request.nextUrl.searchParams;
      const maxCustomers = numParam(sp.get("maxCustomers"));
      const throttleMs = numParam(sp.get("throttleMs"));
      const startPage = numParam(sp.get("startPage"));
      const startStatusRaw = sp.get("startStatus");
      const startStatus: SubscriberStatus | undefined =
        startStatusRaw && (SUBSCRIBER_STATUSES as readonly string[]).includes(startStatusRaw)
          ? (startStatusRaw as SubscriberStatus)
          : undefined;
      const reset = sp.get("reset") === "1";

      const started = Date.now();
      const result = await backfillRevenueForRange({
        from,
        to,
        startStatus,
        startPage,
        maxCustomers,
        throttleMs,
        reset,
        persist: sp.get("dryRun") !== "1",
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

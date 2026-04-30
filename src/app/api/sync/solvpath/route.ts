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
import { listActiveTenants } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel Pro cap; long-running customer iteration

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

  // Resolve tenant for the call. Solvpath client now reads creds per-tenant
  // (DB-stored, env-var fallback). With a single active tenant we default
  // to it; otherwise the caller must pass ?tenantId=<uuid>.
  const explicitTenantId = request.nextUrl.searchParams.get("tenantId");
  let tenantId = explicitTenantId ?? null;
  if (!tenantId) {
    const tenants = await listActiveTenants();
    if (tenants.length === 1) tenantId = tenants[0].id;
    else
      return Response.json(
        {
          error:
            "Multiple active tenants — pass ?tenantId=<uuid> to disambiguate.",
          tenants: tenants.map((t) => ({ id: t.id, name: t.display_name })),
        },
        { status: 400 },
      );
  }

  const action = request.nextUrl.searchParams.get("action") ?? "ping";

  try {
    if (action === "ping") {
      const stores = await listStores(tenantId, { Limit: 25, Page: 1 });
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
          for await (const c of iterateCustomers(tenantId, status, 25)) {
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
      const history = await getTransactionHistory(tenantId, customerId, startDate);
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
        // Dump first row in full so we can see every field Solvpath returns
        // (StoreCode etc) — used to validate the cross-store filter rule.
        rawFirstTx: rows[0] ?? null,
      });
    }

    if (action === "diag") {
      // Walk N Active subscribers, pull each one's Apr tx window, and report
      // the cross-product of (customer profile, tx Type, RecurringOrderCount)
      // so we can decide how to recognize "first subscription sale" rows
      // that Solvpath labels Type="Direct" instead of Type="Initial".
      const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
      const status = request.nextUrl.searchParams.get("subStatus") ?? "Active";
      const startDate =
        request.nextUrl.searchParams.get("from") ?? "2026-04-10";
      const out: unknown[] = [];
      let walked = 0;
      for await (const cust of iterateCustomers(tenantId, status, 25)) {
        if (walked >= limit) break;
        walked += 1;
        let history;
        try {
          history = await getTransactionHistory(
            tenantId,
            cust.CustomerId,
            startDate,
          );
        } catch (e) {
          out.push({
            customerId: cust.CustomerId,
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        const rows = (history.Result ?? []).filter((tx) => {
          if (!tx.Date) return false;
          return tx.Date.slice(0, 10) >= startDate;
        });
        out.push({
          customerId: cust.CustomerId,
          subStatus: cust.SubscriptionStatus,
          successOrderId: cust.SuccessOrderId,
          originalTxDate: cust.OriginalTransactionDate,
          enrollmentDate: cust.EnrollmentDate,
          cancelledDate: cust.CancelledSubscriptionDate,
          tx: rows.map((tx) => ({
            date: tx.Date,
            store: storeFromDomain(tx.Domain),
            type: tx.Type,
            transactionType: tx.TransactionType,
            orderId: tx.OrderId,
            isSuccessOrder: tx.OrderId === cust.SuccessOrderId,
            recurringOrderCount: tx.RecurringOrderCount,
            responseCode: tx.ResponseCode,
            amount: tx.Amount,
            classified: classifyTransaction(tx),
          })),
        });
      }
      return Response.json({ ok: true, action, status, startDate, walked, customers: out });
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

      // CRON_SECRET-authed — no user session. Resolve via ?tenantId= or
      // single-active-tenant fallback.
      const explicitTenantId = sp.get("tenantId");
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
      const result = await backfillRevenueForRange({
        tenantId,
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
        tenantId,
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

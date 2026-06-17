// Manual sync — user-triggered from the dashboard "Sync Data" button.
//
// Unlike the cron routes (which auth via CRON_SECRET), this one uses the
// logged-in tenant session (requireTenant). It syncs a user-chosen date or
// date range across all sources so the operator can refresh specific days
// on demand without waiting for the hourly/daily cron.
//
//   POST /api/sync/manual
//   body: { from: "YYYY-MM-DD", to?: "YYYY-MM-DD" }   // to defaults to from
//
// Streams progress as newline-delimited JSON (NDJSON) so the Sync Data button
// can show a live progress bar. Each line is one of:
//   { type: "progress", pct, label }      — 0..100 overall %, current step
//   { type: "done", ok, ...result }       — final summary (last line)
//   { type: "error", error }              — fatal error
//
// Sources:
//   • Shopify  — daily_orders + daily_pnl per store, per day
//   • Paysight — subscriptions + transactions, per day
//   • Phoenix  — PORTFOLIO subscriber-count snapshot (fast). Phoenix per-
//                customer REVENUE is heavy (~5700 customers); it's time-boxed
//                via backfillRevenueForRange so the request returns within
//                budget — if it can't finish, the daily cron completes it.
//
// Range cap: 31 days, so a single click can't kick off an unbounded backfill.

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncDailyOrders } from "@/lib/shopify/sync";
import { computeDailyPnl } from "@/lib/pnl/compute";
import { hasStoreCreds } from "@/lib/shopify/stores";
import { syncPaysightDay } from "@/lib/paysight/sync";
import { getPaysightCreds, getSolvpathCreds } from "@/lib/integrations";
import { backfillRevenueForRange, SUBSCRIBER_STATUSES } from "@/lib/solvpath/sync";
import { listCustomers } from "@/lib/solvpath/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;
const PHX_BUDGET_MS = 600_000; // leave headroom under the 800s cap

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

async function refreshPhoenixCounts(tenantId: string) {
  const counts: Record<string, number> = {};
  for (const status of SUBSCRIBER_STATUSES) {
    const r = await listCustomers(tenantId, {
      Page: 1,
      Limit: 1,
      SubscriptionStatus: status,
    });
    counts[status] = r.TotalCount ?? 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  const sb = supabaseAdmin();
  await sb.from("phx_summary_snapshots").upsert(
    {
      tenant_id: tenantId,
      store_id: "PORTFOLIO",
      range_from: today,
      range_to: today,
      scrape_date: today,
      scraped_at: new Date().toISOString(),
      active_subscribers: counts["Active"] ?? 0,
      cancelled_subscribers: counts["Canceled"] ?? 0,
      subscribers_in_salvage: null,
      raw_json: { source: "manual-sync", counts },
    },
    { onConflict: "tenant_id,store_id,range_from,range_to" },
  );
  return counts;
}

export async function POST(req: NextRequest) {
  let tenant;
  try {
    tenant = await requireTenant();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    from?: string;
    to?: string;
    sources?: string[]; // optional subset; default all
    storeIds?: string[]; // optional Shopify store subset; default all stores
    // When false, skip the heavy Phoenix per-customer revenue walk and only
    // refresh the fast PORTFOLIO subscriber counts. The Subscriptions quick-
    // sync passes false so the click returns in seconds; the daily cron still
    // reconciles full Phoenix revenue. Defaults to true.
    phoenixRevenue?: boolean;
  } | null;
  const doPhoenixRevenue = body?.phoenixRevenue !== false;

  const from = body?.from ?? "";
  const to = body?.to || from;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "invalid date(s)" }, { status: 400 });
  }
  if (to < from) {
    return NextResponse.json({ error: "to is before from" }, { status: 400 });
  }
  const dates = daysInRange(from, to);
  if (dates.length > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `range too wide — max ${MAX_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  const sources = new Set(
    (body?.sources && body.sources.length
      ? body.sources
      : ["shopify", "paysight", "phoenix"]
    ).map((s) => s.toLowerCase()),
  );

  // Optional Shopify store filter. The Stores page passes its drop-ship store
  // IDs so a "Sync Now" there doesn't also re-sync the subscription stores.
  const storeFilter =
    body?.storeIds && body.storeIds.length
      ? new Set(body.storeIds.map((s) => s.toUpperCase()))
      : null;

  const tenantId = tenant.id;
  const started = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      // Overall progress is split into weighted phases so the bar advances
      // smoothly across sources. Each active source gets an equal slice;
      // within a source we interpolate by units done / units total.
      const activePhases = [
        sources.has("shopify") ? "shopify" : null,
        sources.has("paysight") ? "paysight" : null,
        sources.has("phoenix") ? "phoenix" : null,
      ].filter(Boolean) as string[];
      const slice = activePhases.length ? 100 / activePhases.length : 100;
      let phaseBase = 0; // % already completed by earlier phases
      const emit = (frac: number, label: string) => {
        const pct = Math.min(99, Math.round(phaseBase + slice * frac));
        send({ type: "progress", pct, label });
      };

      const sb = supabaseAdmin();
      const result: Record<string, unknown> = { from, to, days: dates.length };

      try {
        // ── Shopify ──
        if (sources.has("shopify")) {
          emit(0, "Shopify — preparing…");
          const { data: stores } = await sb
            .from("stores")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("is_active", true)
            .neq("id", "PORTFOLIO")
            .neq("id", "__BACKFILL_DEDUPE__");
          const storeList = (stores ?? []).filter(
            (s) => !storeFilter || storeFilter.has(s.id.toUpperCase()),
          );
          const totalUnits = storeList.length * dates.length || 1;
          let unit = 0;
          let orders = 0;
          let failed = 0;
          const perStore: Record<string, number> = {};
          for (const store of storeList) {
            if (!(await hasStoreCreds(store.id, tenantId))) {
              unit += dates.length;
              continue;
            }
            for (const date of dates) {
              try {
                const pull = await syncDailyOrders(store.id, date, tenantId);
                await computeDailyPnl(store.id, date, tenantId);
                orders += pull.orderCount;
                perStore[store.id] = (perStore[store.id] ?? 0) + pull.orderCount;
              } catch {
                failed++;
              }
              unit++;
              emit(unit / totalUnits, `Shopify — ${store.id} ${date}`);
            }
          }
          result.shopify = { orders, failed, perStore };
          phaseBase += slice;
        }

        // ── Paysight ──
        if (sources.has("paysight")) {
          emit(0, "Paysight — preparing…");
          const creds = await getPaysightCreds(tenantId);
          if (creds) {
            let subs = 0;
            let tx = 0;
            let failed = 0;
            let unit = 0;
            for (const date of dates) {
              try {
                const r = await syncPaysightDay(tenantId, date);
                subs += r.subscriptionsUpserted;
                tx += r.transactionsUpserted;
              } catch {
                failed++;
              }
              unit++;
              emit(unit / dates.length, `Paysight — ${date}`);
            }
            result.paysight = { subs, tx, failed };
          } else {
            result.paysight = { skipped: "no creds" };
          }
          phaseBase += slice;
        }

        // ── Phoenix ──
        if (sources.has("phoenix")) {
          emit(0, "Phoenix — subscriber counts…");
          const creds = await getSolvpathCreds(tenantId);
          if (creds) {
            let counts: Record<string, number> | null = null;
            try {
              counts = await refreshPhoenixCounts(tenantId);
            } catch {
              /* ignore — counts are best-effort */
            }
            if (!doPhoenixRevenue) {
              emit(1, "Phoenix — counts done");
              result.phoenix = {
                activeSubscribers: counts?.["Active"] ?? null,
                revenueWalk: "skipped (counts only)",
                chunks: 0,
              };
            } else {
              // Revenue walk is open-ended (~5700 customers across chunks); we
              // can't know the total up front, so we approach 100% smoothly
              // (each chunk closes part of the remaining gap) rather than
              // claiming an exact %.
              let startStatus:
                | "Active"
                | "Canceled"
                | "Never Enrolled"
                | undefined;
              let startPage: number | undefined;
              let chunks = 0;
              let finished = false;
              let seenTotal = 0;
              while (Date.now() - started < PHX_BUDGET_MS) {
                const r = await backfillRevenueForRange({
                  tenantId,
                  from,
                  to,
                  deadlineMs: 55_000,
                  startStatus,
                  startPage,
                });
                chunks++;
                seenTotal += r.progress.customersSeen ?? 0;
                if (r.progress.finished) {
                  finished = true;
                  emit(1, "Phoenix — revenue walk done");
                  break;
                }
                startStatus = r.progress.nextStatus ?? undefined;
                startPage = r.progress.nextPage ?? undefined;
                // Asymptotic: 1 - 0.6^chunks closes 40% of the gap each chunk.
                emit(
                  1 - Math.pow(0.6, chunks),
                  `Phoenix — revenue walk (${seenTotal} customers)`,
                );
              }
              result.phoenix = {
                activeSubscribers: counts?.["Active"] ?? null,
                revenueWalk: finished
                  ? "finished"
                  : "time-boxed (run again to continue)",
                chunks,
              };
            }
          } else {
            result.phoenix = { skipped: "no creds" };
          }
          phaseBase += slice;
        }

        result.elapsedMs = Date.now() - started;
        send({ type: "progress", pct: 100, label: "Done" });
        send({ type: "done", ok: true, ...result });
      } catch (e) {
        send({ type: "error", error: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

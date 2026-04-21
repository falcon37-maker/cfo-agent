// Daily Shopify sync — triggered by Vercel cron (see vercel.json).
//
// For every active non-portfolio store:
//   1. Pull today's orders from Shopify (in the store's local timezone)
//   2. Recompute daily_pnl for that (store, date) row
//
// Auth: Vercel cron includes an `Authorization: Bearer <CRON_SECRET>` header
// on every cron-triggered request. Middleware lets /api/cron/* through; this
// route enforces the secret itself.

import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncDailyOrders } from "@/lib/shopify/sync";
import { computeDailyPnl } from "@/lib/pnl/compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // one store rarely takes >60s; give ourselves headroom

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function handle(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed — no secret configured means the cron is effectively disabled.
    return Response.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }

  // Vercel's built-in cron sets Authorization: Bearer <secret>.
  // Allow a `?secret=` query-string for manual trigger during development.
  const auth = request.headers.get("authorization");
  const qsSecret = request.nextUrl.searchParams.get("secret");
  const ok =
    auth === `Bearer ${expected}` || (qsSecret && qsSecret === expected);
  if (!ok) return unauthorized();

  const sb = supabaseAdmin();
  const { data: stores, error: storesErr } = await sb
    .from("stores")
    .select("id, timezone, shop_domain")
    .eq("is_active", true)
    .neq("id", "PORTFOLIO");
  if (storesErr) {
    return Response.json({ error: storesErr.message }, { status: 500 });
  }

  const started = Date.now();
  const results = [];
  for (const store of stores ?? []) {
    const date = todayInTz(store.timezone ?? "UTC");
    try {
      const pull = await syncDailyOrders(store.id, date);
      const pnl = await computeDailyPnl(store.id, date);
      results.push({
        store: store.id,
        date,
        ok: true,
        orderCount: pull.orderCount,
        grossSales: pull.grossSales,
        netProfit: pnl?.net_profit ?? null,
      });
    } catch (err) {
      results.push({
        store: store.id,
        date,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    ok: true,
    ranAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    results,
  });
}

export const GET = handle;
export const POST = handle;

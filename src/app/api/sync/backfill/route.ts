import { NextRequest } from "next/server";
import { backfillLastNDays, backfillRange } from "@/lib/pnl/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds — for Vercel prod; dev has no limit

// POST /api/sync/backfill?store=NOVA&days=90
// OR   /api/sync/backfill?store=NOVA&from=YYYY-MM-DD&to=YYYY-MM-DD
export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const storeCode = params.get("store");
  if (!storeCode) {
    return Response.json({ error: "missing `store`" }, { status: 400 });
  }

  try {
    const daysParam = params.get("days");
    const from = params.get("from");
    const to = params.get("to");

    const started = Date.now();
    const results =
      from && to
        ? await backfillRange(storeCode, from, to)
        : await backfillLastNDays(storeCode, daysParam ? Number(daysParam) : 90);

    const totalOrders = results.reduce((s, r) => s + r.pull.orderCount, 0);
    const totalRevenue = results.reduce((s, r) => s + r.pull.grossSales, 0);
    const totalNetProfit = results.reduce((s, r) => s + r.netProfit, 0);

    return Response.json({
      ok: true,
      storeCode: storeCode.toUpperCase(),
      daysProcessed: results.length,
      totalOrders,
      totalRevenue: round2(totalRevenue),
      totalNetProfit: round2(totalNetProfit),
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

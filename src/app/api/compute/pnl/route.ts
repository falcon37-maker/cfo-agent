import { NextRequest } from "next/server";
import { computeDailyPnl } from "@/lib/pnl/compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/compute/pnl?store=NOVA&date=YYYY-MM-DD
export async function POST(request: NextRequest) {
  const storeCode = request.nextUrl.searchParams.get("store");
  const date = request.nextUrl.searchParams.get("date");

  if (!storeCode || !date) {
    return Response.json(
      { error: "missing `store` or `date`" },
      { status: 400 },
    );
  }

  try {
    const row = await computeDailyPnl(storeCode, date);
    return Response.json({ ok: true, pnl: row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

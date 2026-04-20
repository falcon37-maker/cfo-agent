import { NextRequest } from "next/server";
import { syncDailyOrders } from "@/lib/shopify/sync";
import { listConfiguredStores } from "@/lib/shopify/stores";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sync/today?store=NOVA[&date=YYYY-MM-DD]
// - store: required. Short code (e.g. NOVA).
// - date:  optional. Defaults to "today" in the store's timezone.
export async function GET(request: NextRequest) {
  const storeCode = request.nextUrl.searchParams.get("store");
  const dateParam = request.nextUrl.searchParams.get("date");

  if (!storeCode) {
    return Response.json(
      {
        error: "missing `store` query param",
        configuredStores: listConfiguredStores(),
      },
      { status: 400 },
    );
  }

  try {
    const date = dateParam ?? (await todayInStoreTz(storeCode));
    const result = await syncDailyOrders(storeCode, date);
    return Response.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

async function todayInStoreTz(storeCode: string): Promise<string> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("stores")
    .select("timezone")
    .eq("id", storeCode.toUpperCase())
    .maybeSingle();
  const tz = data?.timezone ?? "UTC";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

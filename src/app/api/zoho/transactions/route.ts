// GET /api/zoho/transactions?account_id=...&date_start=...&date_end=...&status=...
// Zoho: GET /bankaccounts/{account_id}/transactions
// If no account_id is passed, we fall back to /banktransactions which returns
// all transactions across connected bank accounts.

import { NextRequest, NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const tenant = await requireTenant();
    const sp = new URL(req.url).searchParams;
    const account_id = sp.get("account_id");
    const date_start = sp.get("date_start") ?? undefined;
    const date_end = sp.get("date_end") ?? undefined;
    const status = sp.get("status") ?? undefined; // uncategorized | categorized | ...

    const query: Record<string, string> = {};
    if (date_start) query.from_date = date_start;
    if (date_end) query.to_date = date_end;
    if (status) query.status = status;

    const path = account_id
      ? `/bankaccounts/${encodeURIComponent(account_id)}/transactions`
      : "/banktransactions";
    const data = await zohoFetch<unknown>(tenant.id, path, { query });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

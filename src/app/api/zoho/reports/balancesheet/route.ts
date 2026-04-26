import { NextRequest, NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const tenant = await requireTenant();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const data = await zohoFetch<unknown>(tenant.id, "/reports/balancesheet", {
      query: params,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

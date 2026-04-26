import { NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tenant = await requireTenant();
    const data = await zohoFetch<{ bankaccounts: unknown[] }>(
      tenant.id,
      "/bankaccounts",
    );
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

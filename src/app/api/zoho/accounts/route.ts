// Chart of accounts — the category list the agent needs before categorizing.
import { NextRequest, NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const data = await zohoFetch<{ chartofaccounts: unknown[] }>(
      "/chartofaccounts",
      { query: params },
    );
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

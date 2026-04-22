import { NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await zohoFetch<{ bankaccounts: unknown[] }>("/bankaccounts");
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

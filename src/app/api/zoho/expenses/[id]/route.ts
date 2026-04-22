// PUT /api/zoho/expenses/[id] — update an existing expense

import { NextRequest, NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const data = await zohoFetch<unknown>(
      `/expenses/${encodeURIComponent(id)}`,
      { method: "PUT", body },
    );
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

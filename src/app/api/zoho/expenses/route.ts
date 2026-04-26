// GET /api/zoho/expenses — pass-through with filters
// POST /api/zoho/expenses — create expense
// Body: { account_id, date, amount, vendor_name?, description?, is_billable? }

import { NextRequest, NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const tenant = await requireTenant();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const data = await zohoFetch<unknown>(tenant.id, "/expenses", {
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

type CreateBody = {
  account_id: string;
  date: string;
  amount: number;
  vendor_name?: string;
  description?: string;
  is_billable?: boolean;
  paid_through_account_id?: string;
};

export async function POST(req: NextRequest) {
  try {
    const tenant = await requireTenant();
    const body = (await req.json()) as CreateBody;
    if (!body.account_id || !body.date || body.amount == null) {
      return NextResponse.json(
        { error: "account_id, date, and amount are required" },
        { status: 400 },
      );
    }
    const data = await zohoFetch<unknown>(tenant.id, "/expenses", {
      method: "POST",
      body,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

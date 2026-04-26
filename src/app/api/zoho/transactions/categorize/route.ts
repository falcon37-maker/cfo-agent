// POST /api/zoho/transactions/categorize
// Body: { transaction_id, account_id, description?, amount?, date? }
// Zoho: POST /banktransactions/uncategorized/{transaction_id}/categorize
// `account_id` here is the chart-of-accounts category (NOT the bank account).

import { NextRequest, NextResponse } from "next/server";
import { zohoFetch } from "@/lib/zoho/client";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

type Body = {
  transaction_id: string;
  account_id: string; // category from chart of accounts
  description?: string;
  amount?: number;
  date?: string;
};

export async function POST(req: NextRequest) {
  try {
    const tenant = await requireTenant();
    const body = (await req.json()) as Body;
    if (!body.transaction_id || !body.account_id) {
      return NextResponse.json(
        { error: "transaction_id and account_id are required" },
        { status: 400 },
      );
    }

    const payload: Record<string, unknown> = {
      from_account_id: body.account_id,
    };
    if (body.description) payload.description = body.description;
    if (body.amount != null) payload.amount = body.amount;
    if (body.date) payload.date = body.date;

    const data = await zohoFetch<unknown>(
      tenant.id,
      `/banktransactions/uncategorized/${encodeURIComponent(body.transaction_id)}/categorize`,
      { method: "POST", body: payload },
    );
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

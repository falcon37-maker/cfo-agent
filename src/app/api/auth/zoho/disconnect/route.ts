// POST /api/auth/zoho/disconnect — wipes the stored tokens.
// Note: this does NOT revoke the refresh_token with Zoho. To fully revoke,
// admin must remove the app from https://accounts.zoho.com/home#sessions.

import { NextRequest, NextResponse } from "next/server";
import { deleteCredentials } from "@/lib/zoho/tokens";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const tenant = await requireTenant();
    await deleteCredentials(tenant.id);
    const origin = new URL(req.url).origin;
    return NextResponse.redirect(
      `${origin}/settings/integrations?zoho_disconnected=1`,
      { status: 303 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

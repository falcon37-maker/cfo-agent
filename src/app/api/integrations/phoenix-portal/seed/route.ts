// One-time seed of the Phoenix portal refresh_token.
//
// POST from the logged-in CFO app with { refreshToken } copied from the
// Phoenix portal (localStorage.refresh_token). The token is validated and
// stored encrypted in integrations(provider='phoenix_portal'). After this the
// daily cron + "Sync Now" can pull Phoenix billing via the bulk API with no
// browser session — the refresh_token (7-day, rotating) is renewed server-side.

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentTenant, WRITE_DATA_ROLES } from "@/lib/tenant";
import { seedRefreshToken } from "@/lib/phoenix-portal/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tenant = await getCurrentTenant(auth);
  if (!WRITE_DATA_ROLES.includes(tenant.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    refreshToken?: string;
  } | null;
  const refreshToken = body?.refreshToken?.trim();
  if (!refreshToken || refreshToken.split(".").length !== 3) {
    return NextResponse.json(
      { error: "refreshToken (a JWT) required in body" },
      { status: 400 },
    );
  }

  try {
    await seedRefreshToken(tenant.id, refreshToken);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

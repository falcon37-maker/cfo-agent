// POST /api/stores/test-connection
// Body: { storeId: "NOVA" }
//
// Pings Shopify Admin GraphQL with the store's stored credentials and
// reports back whether the token is valid, what shop info Shopify returns,
// and how the credentials were resolved (DB row vs env-var fallback).
//
// Used by the settings page to render a per-store status pill:
//   - "Connected"       → live ping succeeded
//   - "Invalid token"   → Shopify returned 401 (token revoked / wrong)
//   - "Needs token"     → no credentials configured at all
//   - "Error"           → any other failure (network, scope, etc.)

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getStoreCreds } from "@/lib/shopify/stores";
import { ShopifyClient } from "@/lib/shopify/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let tenant;
  try {
    tenant = await requireTenant();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    storeId?: string;
  } | null;
  const storeId = (body?.storeId ?? "").toUpperCase();
  if (!/^[A-Z0-9_]{1,32}$/.test(storeId)) {
    return NextResponse.json({ error: "invalid storeId" }, { status: 400 });
  }

  // DB-only credential resolution as of the env→DB migration (Jun 2026).
  // sync code stopped reading env vars at runtime, so there's nothing to
  // disambiguate here — either the stores row carries a token or it doesn't.
  const sb = supabaseAdmin();
  const { data: storeRow } = await sb
    .from("stores")
    .select(
      "shopify_domain, shopify_token_encrypted, shopify_client_id, shopify_client_secret_encrypted",
    )
    .eq("tenant_id", tenant.id)
    .eq("id", storeId)
    .maybeSingle();
  const dbHasToken =
    Boolean(storeRow?.shopify_token_encrypted) ||
    (Boolean(storeRow?.shopify_client_id) &&
      Boolean(storeRow?.shopify_client_secret_encrypted));

  const credSource: "db" | "none" = dbHasToken ? "db" : "none";

  if (credSource === "none") {
    return NextResponse.json({
      status: "missing",
      credSource,
      detail: "No credentials configured for this store.",
    });
  }

  // Resolve creds and ping Shopify.
  let creds;
  try {
    creds = await getStoreCreds(storeId, tenant.id);
  } catch (e) {
    return NextResponse.json({
      status: "error",
      credSource,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const client = new ShopifyClient(creds);
  try {
    const data = await client.graphql<{
      shop: { name: string; ianaTimezone: string; currencyCode: string };
    }>(
      `{ shop { name ianaTimezone currencyCode } }`,
      {},
    );
    return NextResponse.json({
      status: "ok",
      credSource,
      shop: data.shop,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // sync.ts/client.ts surfaces "Shopify 401" for auth failures — anything
    // else (network, 5xx, scope error) is bucketed as a generic error.
    const isAuthFail =
      /\b401\b/.test(msg) ||
      /unauthorized/i.test(msg) ||
      /invalid api key/i.test(msg);
    return NextResponse.json({
      status: isAuthFail ? "invalid" : "error",
      credSource,
      detail: msg.slice(0, 250),
    });
  }
}

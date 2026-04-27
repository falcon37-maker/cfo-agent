"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { encrypt, hasEncryptionKey } from "@/lib/crypto";
import { requireTenant } from "@/lib/tenant";

const STORE_CODE_RE = /^[A-Z][A-Z0-9_]{1,15}$/;

function bad(reason: string): never {
  redirect(`/settings?err=${encodeURIComponent(reason)}`);
}

function pickStoreFields(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  const storeType = String(formData.get("store_type") ?? "shopify").trim();
  const shopifyDomain = String(formData.get("shopify_domain") ?? "").trim();
  const shopifyClientId = String(formData.get("shopify_client_id") ?? "").trim();
  const shopifyClientSecret = String(formData.get("shopify_client_secret") ?? "").trim();
  const shopifyToken = String(formData.get("shopify_token") ?? "").trim();
  const processingFeePctStr = String(formData.get("processing_fee_pct") ?? "");
  const processingFeeFixedStr = String(formData.get("processing_fee_fixed") ?? "");
  const isActive = formData.get("is_active") === "on";

  return {
    id,
    name,
    storeType,
    shopifyDomain,
    shopifyClientId,
    shopifyClientSecret,
    shopifyToken,
    processingFeePct: processingFeePctStr === "" ? null : Number(processingFeePctStr),
    processingFeeFixed: processingFeeFixedStr === "" ? null : Number(processingFeeFixedStr),
    isActive,
  };
}

function validate(f: ReturnType<typeof pickStoreFields>) {
  if (!STORE_CODE_RE.test(f.id)) {
    bad("invalid_code"); // 2-16 chars, uppercase, A-Z + 0-9 + _
  }
  if (!f.name) bad("missing_name");
  if (f.storeType !== "shopify" && f.storeType !== "manual") bad("invalid_type");
  if (f.processingFeePct != null && !Number.isFinite(f.processingFeePct)) bad("bad_fee_pct");
  if (f.processingFeeFixed != null && !Number.isFinite(f.processingFeeFixed)) bad("bad_fee_fixed");

  if (f.storeType === "shopify") {
    if (!f.shopifyDomain) bad("missing_domain");
    // Either a shpat_ static token OR (client_id + shpss_ secret) is required.
    const hasStatic = f.shopifyToken.startsWith("shpat_");
    const hasOAuth =
      Boolean(f.shopifyClientId) && f.shopifyClientSecret.startsWith("shpss_");
    if (!hasStatic && !hasOAuth) bad("missing_token_or_oauth");
    if ((hasStatic || hasOAuth) && !hasEncryptionKey()) bad("missing_enc_key");
  }
}

/** Insert a new store. Encrypts shopify creds if provided. */
export async function createStoreAction(formData: FormData) {
  const tenant = await requireTenant();
  const f = pickStoreFields(formData);
  validate(f);

  const sb = supabaseAdmin();
  const row: Record<string, unknown> = {
    tenant_id: tenant.id,
    id: f.id,
    name: f.name,
    store_type: f.storeType,
    shop_domain: f.shopifyDomain || `${f.id.toLowerCase()}.local`, // fallback so the existing UI still has something to show
    is_active: f.isActive,
    timezone: "UTC",
    currency: "USD",
    processing_fee_pct: f.processingFeePct,
    processing_fee_fixed: f.processingFeeFixed,
  };

  if (f.storeType === "shopify") {
    row.shopify_domain = f.shopifyDomain;
    if (f.shopifyToken.startsWith("shpat_")) {
      row.shopify_token_encrypted = encrypt(f.shopifyToken);
      row.shopify_client_id = null;
      row.shopify_client_secret_encrypted = null;
    } else if (f.shopifyClientSecret.startsWith("shpss_")) {
      row.shopify_client_id = f.shopifyClientId;
      row.shopify_client_secret_encrypted = encrypt(f.shopifyClientSecret);
      row.shopify_token_encrypted = null;
    }
  }

  const { error } = await sb.from("stores").insert(row);
  if (error) {
    if (error.code === "23505") bad("duplicate_id");
    bad(`db:${error.message.slice(0, 60)}`);
  }

  revalidatePath("/settings");
  redirect(`/settings?ok=${encodeURIComponent(`added ${f.id}`)}`);
}

export async function updateStoreAction(formData: FormData) {
  const tenant = await requireTenant();
  const f = pickStoreFields(formData);
  validate(f);

  const sb = supabaseAdmin();
  const update: Record<string, unknown> = {
    name: f.name,
    store_type: f.storeType,
    is_active: f.isActive,
    processing_fee_pct: f.processingFeePct,
    processing_fee_fixed: f.processingFeeFixed,
  };

  if (f.storeType === "shopify") {
    update.shopify_domain = f.shopifyDomain;
    // Empty cred fields = "leave existing values alone", so admins can edit
    // the row without having to re-paste secrets.
    if (f.shopifyToken.startsWith("shpat_")) {
      update.shopify_token_encrypted = encrypt(f.shopifyToken);
      update.shopify_client_id = null;
      update.shopify_client_secret_encrypted = null;
    } else if (f.shopifyClientSecret.startsWith("shpss_") && f.shopifyClientId) {
      update.shopify_client_id = f.shopifyClientId;
      update.shopify_client_secret_encrypted = encrypt(f.shopifyClientSecret);
      update.shopify_token_encrypted = null;
    } else if (f.shopifyClientId && !f.shopifyClientSecret) {
      // Just rotating the client_id without changing the secret.
      update.shopify_client_id = f.shopifyClientId;
    }
  }

  const { error } = await sb
    .from("stores")
    .update(update)
    .eq("tenant_id", tenant.id)
    .eq("id", f.id);
  if (error) bad(`db:${error.message.slice(0, 60)}`);

  revalidatePath("/settings");
  redirect(`/settings?ok=${encodeURIComponent(`updated ${f.id}`)}`);
}

/** Soft-delete: flip is_active false; keeps history rows + lets us reactivate. */
export async function deactivateStoreAction(formData: FormData) {
  const tenant = await requireTenant();
  const id = String(formData.get("id") ?? "").trim().toUpperCase();
  if (!STORE_CODE_RE.test(id)) bad("invalid_code");

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("stores")
    .update({ is_active: false })
    .eq("tenant_id", tenant.id)
    .eq("id", id);
  if (error) bad(`db:${error.message.slice(0, 60)}`);

  revalidatePath("/settings");
  redirect(`/settings?ok=${encodeURIComponent(`deactivated ${id}`)}`);
}

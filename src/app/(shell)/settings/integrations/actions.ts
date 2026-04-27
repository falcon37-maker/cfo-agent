"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ping } from "@/lib/chargeblast/client";
import { syncAlerts } from "@/lib/chargeblast/sync";
import { requireTenant } from "@/lib/tenant";
import {
  getChargeblastCreds,
  saveChargeblastCreds,
  saveSolvpathCreds,
  saveZohoBooksCreds,
} from "@/lib/integrations";

function encode(s: string): string {
  return encodeURIComponent(s).slice(0, 200);
}

// ── Chargeblast ─────────────────────────────────────────────────────────

/** Save (encrypted) Chargeblast credentials for the current tenant. */
export async function saveChargeblastAction(formData: FormData) {
  const tenant = await requireTenant();
  const apiKeyInput = String(formData.get("api_key") ?? "").trim();
  const webhookSecretInput = String(formData.get("webhook_secret") ?? "").trim();

  // Empty input = "leave existing value alone". Magic placeholder
  // "CLEAR" wipes the field instead.
  const apiKey =
    apiKeyInput === "CLEAR" ? "" : apiKeyInput || undefined;
  const webhookSecret =
    webhookSecretInput === "CLEAR" ? "" : webhookSecretInput || undefined;

  await saveChargeblastCreds(tenant.id, { apiKey, webhookSecret });
  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?cb_save=ok");
}

export async function pingChargeblastAction(): Promise<void> {
  const tenant = await requireTenant();
  const creds = await getChargeblastCreds(tenant.id);
  if (!creds?.apiKey) {
    redirect(
      "/settings/integrations?cb_test=fail&cb_msg=API%20key%20not%20saved",
    );
  }
  try {
    const r = await ping(tenant.id);
    redirect(`/settings/integrations?cb_test=ok&cb_total=${r.total}`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings/integrations?cb_test=fail&cb_msg=${encode(msg)}`);
  }
}

export async function syncChargeblastAction(): Promise<void> {
  const tenant = await requireTenant();
  const creds = await getChargeblastCreds(tenant.id);
  if (!creds?.apiKey) {
    redirect("/settings/integrations?cb_sync=fail&cb_msg=API%20key%20not%20saved");
  }
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  try {
    const r = await syncAlerts(tenant.id, {
      start_date: weekAgo,
      end_date: today,
    });
    revalidatePath("/chargebacks");
    redirect(
      `/settings/integrations?cb_sync=ok&cb_seen=${r.seen}&cb_mapped=${r.mapped}&cb_upserted=${r.upserted}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings/integrations?cb_sync=fail&cb_msg=${encode(msg)}`);
  }
}

// ── Solvpath ────────────────────────────────────────────────────────────

export async function saveSolvpathAction(formData: FormData) {
  const tenant = await requireTenant();
  const partnerId = String(formData.get("partner_id") ?? "").trim() || undefined;
  const partnerTokenIn = String(formData.get("partner_token") ?? "").trim();
  const bearerTokenIn = String(formData.get("bearer_token") ?? "").trim();
  const baseUrl = String(formData.get("base_url") ?? "").trim() || undefined;

  await saveSolvpathCreds(tenant.id, {
    partnerId,
    partnerToken: partnerTokenIn === "CLEAR" ? "" : partnerTokenIn || undefined,
    bearerToken: bearerTokenIn === "CLEAR" ? "" : bearerTokenIn || undefined,
    baseUrl,
  });
  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?sp_save=ok");
}

// ── Zoho ────────────────────────────────────────────────────────────────

export async function saveZohoOrgAction(formData: FormData) {
  const tenant = await requireTenant();
  const orgId = String(formData.get("org_id") ?? "").trim() || undefined;
  await saveZohoBooksCreds(tenant.id, { orgId });
  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?zb_save=ok");
}

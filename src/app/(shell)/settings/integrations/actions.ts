"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ping } from "@/lib/chargeblast/client";
import { syncAlerts } from "@/lib/chargeblast/sync";
import { requireTenant } from "@/lib/tenant";

function encode(s: string): string {
  return encodeURIComponent(s).slice(0, 200);
}

/** Chargeblast "Test connection" — calls the ping endpoint, bounces back with
 *  a status banner. */
export async function pingChargeblastAction(): Promise<void> {
  if (!process.env.CHARGEBLAST_API_KEY) {
    redirect("/settings/integrations?cb_test=fail&cb_msg=CHARGEBLAST_API_KEY%20not%20set");
  }
  try {
    const r = await ping();
    redirect(`/settings/integrations?cb_test=ok&cb_total=${r.total}`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings/integrations?cb_test=fail&cb_msg=${encode(msg)}`);
  }
}

/** Chargeblast "Run sync now" — pulls the last 7 days of alerts and upserts. */
export async function syncChargeblastAction(): Promise<void> {
  if (!process.env.CHARGEBLAST_API_KEY) {
    redirect("/settings/integrations?cb_sync=fail&cb_msg=CHARGEBLAST_API_KEY%20not%20set");
  }
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  try {
    const tenant = await requireTenant();
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

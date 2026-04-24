// Chargeblast → chargeblast_alerts upsert. Pulls every alert (optionally
// filtered by status / date range), maps merchant_descriptor to our
// store_id using stores.chargeblast_descriptor, and upserts into the
// cache table.

import { supabaseAdmin } from "@/lib/supabase/admin";
import { iterateAlerts, type ChargeblastAlert, type AlertFilters } from "./client";

export type SyncResult = {
  seen: number;
  mapped: number;
  unmapped: number;
  upserted: number;
  skippedErrors: number;
};

async function loadDescriptorMap(): Promise<Map<string, string>> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select("id, chargeblast_descriptor")
    .not("chargeblast_descriptor", "is", null);
  if (error) throw new Error(`loadDescriptorMap: ${error.message}`);
  const out = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ id: string; chargeblast_descriptor: string | null }>) {
    if (r.chargeblast_descriptor) {
      out.set(r.chargeblast_descriptor.trim().toLowerCase(), r.id);
    }
  }
  return out;
}

export async function syncAlerts(filters: AlertFilters = {}): Promise<SyncResult> {
  const descriptorToStore = await loadDescriptorMap();
  const sb = supabaseAdmin();

  let seen = 0;
  let mapped = 0;
  let unmapped = 0;
  let upserted = 0;
  let skippedErrors = 0;

  // Upsert in batches of 100 to keep payloads small.
  const batch: Array<Record<string, unknown>> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const { error } = await sb
      .from("chargeblast_alerts")
      .upsert(batch, { onConflict: "id" });
    if (error) {
      skippedErrors += batch.length;
    } else {
      upserted += batch.length;
    }
    batch.length = 0;
  };

  for await (const a of iterateAlerts(filters)) {
    seen += 1;
    const descKey = (a.merchant_descriptor ?? "").trim().toLowerCase();
    const storeId = descKey ? descriptorToStore.get(descKey) ?? null : null;
    if (storeId) mapped += 1;
    else unmapped += 1;

    batch.push({
      id: a.id,
      store_id: storeId,
      merchant_descriptor: a.merchant_descriptor,
      card_brand: a.card_brand,
      alert_type: a.alert_type,
      amount: a.amount,
      currency: a.currency || "USD",
      status: a.status,
      reason: a.reason,
      order_id: a.order_id,
      customer_email: a.customer_email,
      chargeblast_created_at: a.created_at,
      chargeblast_updated_at: a.updated_at,
      updated_at: new Date().toISOString(),
    });

    if (batch.length >= 100) await flush();
  }
  await flush();

  return { seen, mapped, unmapped, upserted, skippedErrors };
}

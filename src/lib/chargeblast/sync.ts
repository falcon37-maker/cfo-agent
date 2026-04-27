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

// Alphanumeric-only, lowercased. Chargeblast descriptors come in many
// variants per store (e.g. "NOVASENSE-USA.STORE", "novasense-usa.store-CB-Dev1",
// "NOVASENSE USA STORE 56700RIVERTON WY") — normalizing strips punctuation and
// trailing city/state noise so substring matching works.
function normalizeDescriptor(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type DescriptorEntry = { storeId: string; needle: string };

async function loadDescriptorMap(tenantId: string): Promise<DescriptorEntry[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select("id, chargeblast_descriptor")
    .eq("tenant_id", tenantId)
    .not("chargeblast_descriptor", "is", null);
  if (error) throw new Error(`loadDescriptorMap: ${error.message}`);
  const out: DescriptorEntry[] = [];
  for (const r of (data ?? []) as Array<{ id: string; chargeblast_descriptor: string | null }>) {
    const needle = normalizeDescriptor(r.chargeblast_descriptor ?? "");
    if (needle) out.push({ storeId: r.id, needle });
  }
  // Longer needles first so more-specific stores win ties.
  out.sort((a, b) => b.needle.length - a.needle.length);
  return out;
}

function matchDescriptor(
  descriptor: string | null,
  entries: DescriptorEntry[],
): string | null {
  if (!descriptor) return null;
  const hay = normalizeDescriptor(descriptor);
  if (!hay) return null;
  for (const e of entries) {
    if (hay.includes(e.needle)) return e.storeId;
  }
  return null;
}

export async function syncAlerts(
  tenantId: string,
  filters: AlertFilters = {},
): Promise<SyncResult> {
  const descriptorEntries = await loadDescriptorMap(tenantId);
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

  for await (const a of iterateAlerts(tenantId, filters)) {
    seen += 1;
    const storeId = matchDescriptor(a.merchant_descriptor, descriptorEntries);
    if (storeId) mapped += 1;
    else unmapped += 1;

    batch.push({
      id: a.id,
      tenant_id: tenantId,
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

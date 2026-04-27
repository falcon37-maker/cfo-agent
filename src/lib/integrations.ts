// Per-tenant integration credentials. Stored in `integrations.credentials`
// JSONB; encrypted fields land as base64 envelopes via src/lib/crypto.ts.
//
// Lookup pattern: `getXxxCreds(tenantId)` returns the resolved credentials
// for a provider, decrypting sensitive fields. Each helper falls back to
// the legacy env vars when the DB row is empty so Joseph's setup keeps
// working before the Settings UI is used to (re-)save creds.

import { supabaseAdmin } from "@/lib/supabase/admin";
import { encrypt, decrypt, hasEncryptionKey } from "@/lib/crypto";

export type ChargeblastCreds = {
  apiKey: string;
  webhookSecret?: string;
};

export type SolvpathCreds = {
  partnerId: string;
  partnerToken: string;
  bearerToken: string;
  baseUrl: string;
};

export type ZohoBooksCreds = {
  orgId: string;
};

export type Provider = "chargeblast" | "solvpath" | "zoho_books";

type IntegrationRow = {
  id: string;
  tenant_id: string;
  provider: Provider;
  credentials: Record<string, unknown>;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

const SOLVPATH_DEFAULT_BASE_URL =
  "https://pffe.phoenixtechnologies.io/phxcrm";

async function loadIntegrationRow(
  tenantId: string,
  provider: Provider,
): Promise<IntegrationRow | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("integrations")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`loadIntegrationRow ${provider}: ${error.message}`);
  return (data as IntegrationRow | null) ?? null;
}

function maybeDecrypt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!hasEncryptionKey()) return undefined;
  try {
    return decrypt(value);
  } catch {
    return undefined;
  }
}

/** Resolved Chargeblast creds for a tenant. DB-first, env-var fallback. */
export async function getChargeblastCreds(
  tenantId: string,
): Promise<ChargeblastCreds | null> {
  const row = await loadIntegrationRow(tenantId, "chargeblast");
  const enc = (row?.credentials as Record<string, unknown> | undefined) ?? {};
  const dbApiKey = maybeDecrypt(enc.apiKey);
  const dbWebhookSecret = maybeDecrypt(enc.webhookSecret);

  const apiKey = dbApiKey || process.env.CHARGEBLAST_API_KEY || "";
  const webhookSecret =
    dbWebhookSecret || process.env.CHARGEBLAST_WEBHOOK_SECRET || undefined;
  if (!apiKey) return null;
  return { apiKey, webhookSecret };
}

/** Resolved Solvpath creds for a tenant. DB-first, env-var fallback. */
export async function getSolvpathCreds(
  tenantId: string,
): Promise<SolvpathCreds | null> {
  const row = await loadIntegrationRow(tenantId, "solvpath");
  const enc = (row?.credentials as Record<string, unknown> | undefined) ?? {};
  const dbPartnerId =
    typeof enc.partnerId === "string" ? (enc.partnerId as string) : undefined;
  const dbBaseUrl =
    typeof enc.baseUrl === "string" ? (enc.baseUrl as string) : undefined;
  const dbPartnerToken = maybeDecrypt(enc.partnerToken);
  const dbBearerToken = maybeDecrypt(enc.bearerToken);

  const partnerId = dbPartnerId || process.env.SOLVPATH_PARTNER_ID || "";
  const partnerToken =
    dbPartnerToken || process.env.SOLVPATH_PARTNER_TOKEN || "";
  const bearerToken =
    dbBearerToken || process.env.SOLVPATH_BEARER_TOKEN || "";
  const baseUrl =
    dbBaseUrl ||
    process.env.SOLVPATH_BASE_URL ||
    SOLVPATH_DEFAULT_BASE_URL;
  if (!partnerId || !partnerToken || !bearerToken) return null;
  return { partnerId, partnerToken, bearerToken, baseUrl };
}

export async function getZohoBooksCreds(
  tenantId: string,
): Promise<ZohoBooksCreds | null> {
  const row = await loadIntegrationRow(tenantId, "zoho_books");
  const enc = (row?.credentials as Record<string, unknown> | undefined) ?? {};
  const orgId =
    (typeof enc.orgId === "string" ? (enc.orgId as string) : undefined) ||
    process.env.ZOHO_ORG_ID ||
    "";
  if (!orgId) return null;
  return { orgId };
}

// ── Save helpers (used by Settings actions) ─────────────────────────────

/** Replace credentials for (tenant, provider). Encrypts sensitive fields.
 *  Pass undefined to keep an existing field unchanged. */
export async function saveChargeblastCreds(
  tenantId: string,
  values: { apiKey?: string; webhookSecret?: string },
): Promise<void> {
  const sb = supabaseAdmin();
  const existing = await loadIntegrationRow(tenantId, "chargeblast");
  const cur = (existing?.credentials as Record<string, unknown>) ?? {};
  const next: Record<string, unknown> = { ...cur };
  if (values.apiKey !== undefined) {
    next.apiKey = values.apiKey ? encrypt(values.apiKey) : undefined;
  }
  if (values.webhookSecret !== undefined) {
    next.webhookSecret = values.webhookSecret
      ? encrypt(values.webhookSecret)
      : undefined;
  }
  await upsertIntegration(sb, tenantId, "chargeblast", next);
}

export async function saveSolvpathCreds(
  tenantId: string,
  values: {
    partnerId?: string;
    partnerToken?: string;
    bearerToken?: string;
    baseUrl?: string;
  },
): Promise<void> {
  const sb = supabaseAdmin();
  const existing = await loadIntegrationRow(tenantId, "solvpath");
  const cur = (existing?.credentials as Record<string, unknown>) ?? {};
  const next: Record<string, unknown> = { ...cur };
  if (values.partnerId !== undefined) next.partnerId = values.partnerId || undefined;
  if (values.baseUrl !== undefined) next.baseUrl = values.baseUrl || undefined;
  if (values.partnerToken !== undefined) {
    next.partnerToken = values.partnerToken
      ? encrypt(values.partnerToken)
      : undefined;
  }
  if (values.bearerToken !== undefined) {
    next.bearerToken = values.bearerToken
      ? encrypt(values.bearerToken)
      : undefined;
  }
  await upsertIntegration(sb, tenantId, "solvpath", next);
}

export async function saveZohoBooksCreds(
  tenantId: string,
  values: { orgId?: string },
): Promise<void> {
  const sb = supabaseAdmin();
  const existing = await loadIntegrationRow(tenantId, "zoho_books");
  const cur = (existing?.credentials as Record<string, unknown>) ?? {};
  const next: Record<string, unknown> = { ...cur };
  if (values.orgId !== undefined) next.orgId = values.orgId || undefined;
  await upsertIntegration(sb, tenantId, "zoho_books", next);
}

async function upsertIntegration(
  sb: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  provider: Provider,
  credentials: Record<string, unknown>,
): Promise<void> {
  // Strip undefined keys before storing — JSONB null cleanups.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const { error } = await sb.from("integrations").upsert(
    {
      tenant_id: tenantId,
      provider,
      credentials: clean,
      is_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,provider" },
  );
  if (error) throw new Error(`upsertIntegration ${provider}: ${error.message}`);
}

/** Diagnostic: which fields are populated in the DB row (without
 *  decrypting). Useful for the Settings UI to show "Saved · Empty" badges. */
export async function describeIntegrationStatus(
  tenantId: string,
): Promise<
  Record<
    Provider,
    { configured: boolean; fields: string[]; lastSyncedAt: string | null }
  >
> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("integrations")
    .select("provider, credentials, last_synced_at")
    .eq("tenant_id", tenantId);
  const out: Record<
    Provider,
    { configured: boolean; fields: string[]; lastSyncedAt: string | null }
  > = {
    chargeblast: { configured: false, fields: [], lastSyncedAt: null },
    solvpath: { configured: false, fields: [], lastSyncedAt: null },
    zoho_books: { configured: false, fields: [], lastSyncedAt: null },
  };
  for (const r of (data ?? []) as Array<{
    provider: Provider;
    credentials: Record<string, unknown>;
    last_synced_at: string | null;
  }>) {
    const fields = Object.keys(r.credentials ?? {}).filter(
      (k) =>
        r.credentials[k] !== undefined &&
        r.credentials[k] !== null &&
        r.credentials[k] !== "",
    );
    out[r.provider] = {
      configured: fields.length > 0,
      fields,
      lastSyncedAt: r.last_synced_at,
    };
  }
  return out;
}

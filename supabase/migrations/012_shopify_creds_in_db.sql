-- Multi-tenant phase 1D.1+2: store Shopify credentials in the database.
--
-- Phase 1A-1C kept Shopify creds in env vars (NOVA_DOMAIN, NOVA_TOKEN, etc.)
-- — fine for one tenant, but every new tenant's stores would otherwise
-- require a redeploy to land env vars. This migration adds the columns;
-- the actual cred move happens via scripts/migrate-shopify-creds.mjs after
-- deploy (we can't encrypt from SQL).
--
-- Auth-mode columns mirror the existing src/lib/shopify/stores.ts logic:
--   - shopify_token_encrypted holds shpat_... (legacy custom-app static)
--   - shopify_client_id + shopify_client_secret_encrypted hold the Dev
--     Dashboard OAuth flow (post-Jan-2026)
-- Either pair is sufficient — the client picks based on which is populated.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS shopify_domain                TEXT,
  ADD COLUMN IF NOT EXISTS shopify_token_encrypted       TEXT,
  ADD COLUMN IF NOT EXISTS shopify_client_id             TEXT,
  ADD COLUMN IF NOT EXISTS shopify_client_secret_encrypted TEXT;

-- Convenience: stores.id is unique within a tenant today (single-tenant
-- world), but with multi-tenant we'd want (tenant_id, id) unique. Add
-- that as a composite index for the cred lookup path. Leaving the existing
-- single-column PK alone since FKs reference it.
CREATE INDEX IF NOT EXISTS idx_stores_tenant_id_active
  ON stores(tenant_id, is_active);

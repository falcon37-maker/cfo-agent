-- Phase 2 prep: let Shopify store credentials live in the `stores` table
-- instead of env vars, so admins can add new stores through the Settings
-- UI without a code change or redeploy. Phase 1 (tonight) still reads
-- tokens from env; after this migration lands + we populate `shopify_token`
-- for ELARA/SOLEN/VOLEN, getStoreCreds() can prefer DB values.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS shopify_token       TEXT,
  ADD COLUMN IF NOT EXISTS shopify_api_key     TEXT,
  ADD COLUMN IF NOT EXISTS processing_fee_fixed NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_source      TEXT DEFAULT 'shopify',
  ADD COLUMN IF NOT EXISTS last_synced_at      TIMESTAMPTZ;

-- PHX stores have revenue sourced from Solvpath, not Shopify.
UPDATE stores
   SET revenue_source = 'phx'
 WHERE id IN ('NOVA', 'NURA', 'KOVA');

-- New Shopify Payments stores get the $0.30 per-tx flat fee.
UPDATE stores
   SET processing_fee_fixed = 0.30
 WHERE id IN ('ELARA', 'SOLEN', 'VOLEN');

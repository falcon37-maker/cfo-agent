-- Zoho Books OAuth tokens. Single-tenant for now: one row per org_id.
-- Access tokens expire after 1 hour; refresh_token does not expire unless
-- revoked, so we upsert on org_id and keep refreshing in place.

CREATE TABLE IF NOT EXISTS zoho_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Service-role only (we never expose these tokens to the browser).
ALTER TABLE zoho_credentials DISABLE ROW LEVEL SECURITY;

-- Minimal OAuth 2.0 authorization-code store for the MCP connector.
--
-- Claude.ai's "Connect" flow requires a real OAuth handshake (it won't use a
-- token supplied in the URL). We run a thin OAuth facade: /oauth/authorize
-- issues a short-lived code bound to the tenant's existing mcp_token, and
-- /oauth/token exchanges that code (with PKCE) for the token. Registered
-- clients are accepted statelessly, so only codes need persistence.
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code                  TEXT PRIMARY KEY,     -- random opaque authorization code
  mcp_token             TEXT NOT NULL,        -- the tenant bearer token to hand back
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  client_id             TEXT NOT NULL,        -- DCR-issued client id (echoed back)
  redirect_uri          TEXT NOT NULL,        -- must match on token exchange
  code_challenge        TEXT,                 -- PKCE S256 challenge (optional but expected)
  code_challenge_method TEXT,                 -- "S256" (only method supported)
  expires_at            TIMESTAMPTZ NOT NULL, -- codes are one-time, ~5 min TTL
  consumed_at           TIMESTAMPTZ,          -- non-null once exchanged (single use)
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expires_idx ON mcp_oauth_codes (expires_at);

ALTER TABLE mcp_oauth_codes DISABLE ROW LEVEL SECURITY;

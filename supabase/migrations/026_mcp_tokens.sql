-- Remote MCP server auth: a bearer token maps to a tenant. Claude Desktop /
-- Claude.ai sends `Authorization: Bearer <token>` and we resolve the tenant.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token        TEXT PRIMARY KEY,          -- random 32+ byte hex
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  label        TEXT,                      -- e.g. "Joseph's Claude Desktop"
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ                -- non-null = disabled
);

CREATE INDEX IF NOT EXISTS mcp_tokens_tenant_idx ON mcp_tokens (tenant_id);

ALTER TABLE mcp_tokens DISABLE ROW LEVEL SECURITY;

-- MCP activity log — one row per tool call made through the remote MCP server
-- (Claude Desktop / Claude.ai). Powers the "Activity" history on the MCP
-- Connector settings page so the owner can see exactly what was done from Claude.
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  token       TEXT,                       -- which token was used (may be revoked later)
  tool_name   TEXT NOT NULL,
  arguments   JSONB,                      -- the tool input
  ok          BOOLEAN NOT NULL DEFAULT TRUE,
  error       TEXT,                       -- error message when ok = false
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_tenant_idx
  ON mcp_tool_calls (tenant_id, created_at DESC);

ALTER TABLE mcp_tool_calls DISABLE ROW LEVEL SECURITY;

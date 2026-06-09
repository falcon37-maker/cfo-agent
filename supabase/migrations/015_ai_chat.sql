-- Phase 1 (AI Chat / CFO Agent bot): persistent chat sessions + messages.
--
-- Goals:
--  - One row per conversation thread (chat_sessions).
--  - One row per message (chat_messages), preserving full assistant tool calls
--    and tool results so the bot has long-term memory across sessions.
--  - Strict tenant isolation via RLS — a user can only read/write their own
--    tenant's chat history. Service-role (cron / server actions) bypasses RLS
--    as usual.
--  - Audit trail for AI-triggered writes (chat_audit_log) so we can always
--    answer "what did the bot change, when, and on whose behalf?"
--
-- Encryption: message content is plaintext in the DB (chat_messages.content).
-- It's only readable by the row's tenant via RLS, and Supabase encrypts at
-- rest. If we ever need stricter handling we can wrap content with the same
-- AES helper used by the integrations table.

-- ── chat_sessions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Optional human label ("April P&L review", "May 1 cleanup"). Auto-set
  -- from the first user message if left null.
  title           TEXT,
  -- 'open' while the user has the widget mounted; 'closed' once archived.
  -- Doesn't restrict reads — purely a UI hint for the sidebar.
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- Model used for the most recent turn — handy for debugging.
  model           TEXT,
  -- Running token usage for cost visibility.
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant
  ON chat_sessions (tenant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user
  ON chat_sessions (user_id, last_message_at DESC);

ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON chat_sessions;
CREATE POLICY "tenant_isolation" ON chat_sessions
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
      UNION
      SELECT id FROM tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
      UNION
      SELECT id FROM tenants WHERE user_id = auth.uid()
    )
  );


-- ── chat_messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  -- 'user' | 'assistant' | 'tool'
  -- - user:      typed by the human
  -- - assistant: model reply (may contain tool_use blocks)
  -- - tool:      result of a tool the assistant invoked
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  -- Plain-text content shown in the UI. For assistant turns this is the
  -- model's narrative reply; for tool rows it's a short status string.
  content         TEXT NOT NULL DEFAULT '',
  -- Full structured content blocks from the Anthropic API (text blocks,
  -- tool_use blocks, tool_result blocks). Replayed verbatim on the next
  -- turn so the model has full conversation context.
  blocks          JSONB,
  -- Token accounting per assistant turn.
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  -- Latency for the assistant turn (ms).
  latency_ms      INTEGER,
  -- If this is a tool row, which tool it came from.
  tool_name       TEXT,
  -- Was this a destructive operation that the user had to confirm?
  required_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON chat_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant
  ON chat_messages (tenant_id, created_at DESC);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON chat_messages;
CREATE POLICY "tenant_isolation" ON chat_messages
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
      UNION
      SELECT id FROM tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
      UNION
      SELECT id FROM tenants WHERE user_id = auth.uid()
    )
  );


-- ── chat_audit_log ────────────────────────────────────────────────────────
-- Every AI-triggered write to a data table lands here. We never blind-trust
-- the model — even confirmed writes are logged so the user can review and
-- reverse them.
CREATE TABLE IF NOT EXISTS chat_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  session_id      UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  message_id      UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Tool that was invoked (e.g. 'update_ad_spend', 'update_cogs').
  tool_name       TEXT NOT NULL,
  -- Target table + row identifier (composite for daily_pnl / daily_orders).
  target_table    TEXT NOT NULL,
  target_pk       JSONB NOT NULL,
  -- Before / after snapshots for the changed row.
  before_value    JSONB,
  after_value     JSONB,
  -- 'applied' once the write succeeded; 'reverted' if the user later
  -- undid it from the audit log.
  status          TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'reverted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_audit_tenant
  ON chat_audit_log (tenant_id, created_at DESC);

ALTER TABLE chat_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON chat_audit_log;
CREATE POLICY "tenant_isolation" ON chat_audit_log
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
      UNION
      SELECT id FROM tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()
      UNION
      SELECT id FROM tenants WHERE user_id = auth.uid()
    )
  );


-- ── triggers: bump chat_sessions.updated_at + last_message_at ─────────────
CREATE OR REPLACE FUNCTION bump_chat_session_on_message()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chat_sessions
     SET last_message_at = NEW.created_at,
         updated_at      = NEW.created_at,
         message_count   = message_count + 1,
         input_tokens    = input_tokens  + COALESCE(NEW.input_tokens, 0),
         output_tokens   = output_tokens + COALESCE(NEW.output_tokens, 0)
   WHERE id = NEW.session_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bump_chat_session ON chat_messages;
CREATE TRIGGER trg_bump_chat_session
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION bump_chat_session_on_message();

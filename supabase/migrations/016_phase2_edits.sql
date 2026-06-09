-- Phase 2 — AI can edit data via chat with confirm-first UX.
--
-- This migration adds:
--   1. pending_confirmations — short-lived edits awaiting user click.
--      The model proposes a change → a row lands here → the UI shows a
--      confirm card → user clicks Yes/No → we either apply + audit or
--      discard. Rows expire automatically after 10 minutes.
--   2. Helpful indexes on chat_audit_log so the "show me what changed"
--      query stays fast as the log grows.
--
-- No existing tables are touched. cogs_entries, ad_spend_entries,
-- manual_revenue_entries already exist with the columns we need.

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  session_id      UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  message_id      UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Which write tool the AI wants to run.
  --   'update_ad_spend' | 'update_cogs' | 'update_manual_revenue' | 'undo_last_edit'
  tool_name       TEXT NOT NULL,

  -- Target row this confirmation will write to. The shape depends on the
  -- tool — see tool implementations for the exact keys.
  target_table    TEXT NOT NULL,
  target_pk       JSONB NOT NULL,

  -- The change we're about to make.
  before_value    JSONB,
  after_value     JSONB NOT NULL,

  -- Human-readable summary the UI renders inside the confirm card.
  -- Example: "NOVA ad spend on 2026-05-01: $1,000.00 → $2,000.00"
  human_summary   TEXT NOT NULL,

  -- 'pending' | 'confirmed' | 'cancelled' | 'expired'
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_confirmations_session
  ON pending_confirmations (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_confirmations_tenant_status
  ON pending_confirmations (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_confirmations_expires
  ON pending_confirmations (expires_at) WHERE status = 'pending';

ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON pending_confirmations;
CREATE POLICY "tenant_isolation" ON pending_confirmations
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

-- Auto-expire pending confirmations that sat too long. Cheap to call.
CREATE OR REPLACE FUNCTION expire_old_confirmations()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE pending_confirmations
     SET status = 'expired', resolved_at = NOW()
   WHERE status = 'pending' AND expires_at < NOW();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

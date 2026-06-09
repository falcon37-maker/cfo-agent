-- Phase 2 data accuracy: surface mismatches between our stored daily_orders
-- and source platforms (Shopify, Solvpath), plus anomaly detection (negative
-- net revenue, missing days, etc.).
--
-- A row here means "the validator caught something" — UI can show a banner
-- "⚠ 3 data validation issues" and link to a debug page that lists them.
-- Closed rows stay for audit; open rows are what drive the warning.

CREATE TABLE IF NOT EXISTS data_validation_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id    text        NULL,
  date        date        NULL,
  check_name  text        NOT NULL,
  severity    text        NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  message     text        NOT NULL,
  details     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_data_validation_tenant_status
  ON data_validation_log (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_data_validation_check
  ON data_validation_log (check_name, created_at DESC);

COMMENT ON TABLE data_validation_log IS
  'Phase 2: rows = data-accuracy issues caught by the daily validator. '
  'Open rows surface as a dashboard warning until resolved.';

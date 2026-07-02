-- AI transaction-labeling staging table (dry-run: stage → confirm → write back
-- to Zoho). One row per Zoho uncategorized bank transaction the AI has looked
-- at. The suggested category is staged here; nothing is written to Zoho until
-- a human confirms. On confirm, the /finance page calls the Zoho categorize
-- endpoint and flips status to 'confirmed' (applied_at set).
--
-- transaction_id is the Zoho banktransaction id (globally unique) → PK.
-- tenant_id scopes rows per workspace (service-role queries filter on it).

CREATE TABLE IF NOT EXISTS transaction_labels (
  transaction_id          TEXT PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Snapshot of the Zoho transaction (so the review UI doesn't re-fetch).
  account_id              TEXT NOT NULL,        -- Zoho bank account id
  account_name            TEXT,
  txn_date                DATE,
  amount                  NUMERIC(14,2),
  debit_or_credit         TEXT,                 -- 'debit' | 'credit'
  payee                   TEXT,
  description             TEXT,

  -- AI suggestion.
  suggested_account_id    TEXT,                 -- chart-of-accounts category id
  suggested_category_name TEXT,
  confidence              NUMERIC(4,3),         -- 0.000 .. 1.000
  reasoning               TEXT,

  -- Review lifecycle.
  status                  TEXT NOT NULL DEFAULT 'suggested', -- suggested | confirmed | rejected
  applied_at              TIMESTAMPTZ,          -- when written back to Zoho

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_labels_tenant   ON transaction_labels(tenant_id);
CREATE INDEX IF NOT EXISTS idx_txn_labels_status   ON transaction_labels(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_txn_labels_account  ON transaction_labels(tenant_id, account_id);

-- Phase 1A parity: RLS off; access goes through the service-role client which
-- already scopes every query by tenant_id.
ALTER TABLE transaction_labels DISABLE ROW LEVEL SECURITY;

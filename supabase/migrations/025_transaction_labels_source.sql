-- Distinguish where a staged transaction came from: the Zoho bank feed vs an
-- uploaded bank-statement PDF. Lets the review queue show a source badge and
-- keeps PDF imports (which have synthetic ids) from being confused with Zoho.

ALTER TABLE transaction_labels
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'zoho';

CREATE INDEX IF NOT EXISTS idx_txn_labels_source
  ON transaction_labels(tenant_id, source);

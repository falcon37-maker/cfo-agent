-- Chargeblast alerts cache. One row per Chargeblast alert_id. Updated by
-- the /api/webhooks/chargeblast webhook (live) and /api/sync/chargeblast
-- (backfill + periodic sync).
--
-- store_id is nullable because a new alert may land before we've mapped
-- its merchant_descriptor to one of our stores. The UI surfaces unmapped
-- alerts in a "needs mapping" bucket.

CREATE TABLE IF NOT EXISTS chargeblast_alerts (
  id                       TEXT PRIMARY KEY,
  store_id                 TEXT REFERENCES stores(id),
  merchant_descriptor      TEXT,
  card_brand               TEXT,
  alert_type               TEXT,
  amount                   NUMERIC(10,2),
  currency                 TEXT DEFAULT 'USD',
  status                   TEXT,
  reason                   TEXT,
  order_id                 TEXT,
  customer_email           TEXT,
  chargeblast_created_at   TIMESTAMPTZ,
  chargeblast_updated_at   TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chargeblast_store
  ON chargeblast_alerts(store_id);
CREATE INDEX IF NOT EXISTS idx_chargeblast_status
  ON chargeblast_alerts(status);
CREATE INDEX IF NOT EXISTS idx_chargeblast_created
  ON chargeblast_alerts(chargeblast_created_at);

ALTER TABLE chargeblast_alerts DISABLE ROW LEVEL SECURITY;

-- Maps a store's Chargeblast merchant_descriptor so the sync + webhook
-- can attach alerts to the right row without guesswork.
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS chargeblast_descriptor TEXT;

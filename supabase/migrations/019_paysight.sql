-- Paysight integration (Phase 6 — Jun 2026).
--
-- Paysight is a subscription/payment CRM (same family as Phoenix/Solvpath
-- and ApexGateway). Per client: pull BOTH Phoenix and Paysight data into
-- the CFO Agent dashboard for a single combined subscription view
-- (Option A — the two platforms don't talk to each other directly).
--
-- We store Paysight's granular per-transaction and per-subscription rows
-- (the API returns row-level data, unlike Phoenix's daily aggregates).
-- Keeping them in dedicated tables means Phoenix and Paysight stay
-- distinguishable for dedup/reconciliation even though they track the
-- same stores.

-- ─── Per-transaction rows from /api/mitigation/transactions ───────────
CREATE TABLE IF NOT EXISTS paysight_transactions (
  id                      bigserial    PRIMARY KEY,
  tenant_id               uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Paysight identity
  paysight_transaction_id text         NOT NULL,          -- Transaction.transactionId (UUID)
  parent_company_id       integer      NULL,              -- = ClientId (505)
  company_id              integer      NULL,
  order_id                bigint       NULL,
  customer_id             bigint       NULL,
  application_id          integer      NULL,              -- 200=Refund 201=Chargeback 202=CB Alert
  -- Store mapping (resolved from descriptor/mid → our store id)
  store_id                text         NULL,              -- NOVA / NURA / KOVA / null
  mid                     text         NULL,
  descriptor              text         NULL,
  -- Money + status
  amount                  numeric(12,2) NOT NULL DEFAULT 0,
  currency                text         NULL,
  status                  text         NULL,              -- human-readable
  status_id               integer      NULL,
  success                 boolean      NULL,
  refunded                boolean      NULL,
  charged_back            boolean      NULL,
  has_alert               boolean      NULL,
  original_transaction_id text         NULL,              -- links refund/chargeback to original
  -- Customer
  email                   text         NULL,
  first_name              text         NULL,
  last_name               text         NULL,
  bin                     text         NULL,
  last4                   text         NULL,
  -- Timing (Paysight UTC)
  sent_at                 timestamptz  NULL,
  completed_at            timestamptz  NULL,
  -- The store-local YYYY-MM-DD this transaction falls under (for daily rollups)
  txn_date                date         NULL,
  gateway                 text         NULL,
  gateway_transaction_id  text         NULL,
  sandbox                 boolean      NOT NULL DEFAULT false,
  raw                     jsonb        NULL,
  synced_at               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT paysight_tx_unique UNIQUE (tenant_id, paysight_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_paysight_tx_store_date
  ON paysight_transactions (tenant_id, store_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_paysight_tx_date
  ON paysight_transactions (tenant_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_paysight_tx_customer
  ON paysight_transactions (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_paysight_tx_original
  ON paysight_transactions (tenant_id, original_transaction_id);

-- ─── Per-subscription rows from /api/mitigation/subscriptions ─────────
CREATE TABLE IF NOT EXISTS paysight_subscriptions (
  id                      bigserial    PRIMARY KEY,
  tenant_id               uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  paysight_subscription_id bigint      NOT NULL,          -- Subscription.id
  parent_company_id       integer      NULL,
  company_id              integer      NULL,
  customer_id             bigint       NULL,
  order_id                bigint       NULL,
  sub_plan_id             integer      NULL,              -- Subscription.subId
  -- Store mapping
  store_id                text         NULL,
  mid                     text         NULL,
  descriptor              text         NULL,
  -- State
  active                  boolean      NULL,
  frozen                  boolean      NULL,
  unsubscribe_order_id    bigint       NULL,
  email                   text         NULL,
  -- Timing
  sub_date                timestamptz  NULL,
  unsub_date              timestamptz  NULL,
  raw                     jsonb        NULL,
  synced_at               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT paysight_sub_unique UNIQUE (tenant_id, paysight_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_paysight_sub_store
  ON paysight_subscriptions (tenant_id, store_id, active);
CREATE INDEX IF NOT EXISTS idx_paysight_sub_customer
  ON paysight_subscriptions (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_paysight_sub_date
  ON paysight_subscriptions (tenant_id, sub_date DESC);

-- ─── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE paysight_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE paysight_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "paysight_tx_tenant_isolation" ON paysight_transactions;
CREATE POLICY "paysight_tx_tenant_isolation" ON paysight_transactions
  FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() LIMIT 1));

DROP POLICY IF EXISTS "paysight_sub_tenant_isolation" ON paysight_subscriptions;
CREATE POLICY "paysight_sub_tenant_isolation" ON paysight_subscriptions
  FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() LIMIT 1));

COMMENT ON TABLE paysight_transactions IS
  'Per-transaction rows pulled from Paysight /api/mitigation/transactions. '
  'Powers the combined Phoenix+Paysight subscription dashboard (Phase 6).';
COMMENT ON TABLE paysight_subscriptions IS
  'Per-subscription rows pulled from Paysight /api/mitigation/subscriptions.';

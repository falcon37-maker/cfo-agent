-- Per-order Shopify detail storage. Previously we only kept daily aggregates
-- in `daily_orders`; the P&L expand panel was making a live GraphQL call to
-- Shopify on every click. This table lets us serve the expand panel from our
-- own DB (faster, no rate limits) and gives us a source-of-truth for
-- per-order analytics going forward.
--
-- Filled by `syncDailyOrders` during the same scan that aggregates into
-- `daily_orders`. Each (tenant, store, shopify_order_id) is unique.

CREATE TABLE IF NOT EXISTS shopify_orders (
  id                  bigserial    PRIMARY KEY,
  tenant_id           uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id            text         NOT NULL,
  shopify_order_id    text         NOT NULL,
  name                text         NOT NULL,          -- "#5184"
  created_at_shopify  timestamptz  NOT NULL,          -- Shopify's createdAt (UTC)
  cancelled_at        timestamptz  NULL,
  -- The store-local YYYY-MM-DD this order falls under, computed in the
  -- store's IANA timezone at sync time. This is what we filter on when
  -- the user expands a ledger row — keeps it aligned with daily_orders.
  store_local_date    date         NOT NULL,
  -- Display / Shopify-Admin parity fields:
  customer_name       text         NULL,
  customer_email      text         NULL,
  channel             text         NULL,              -- "Online Store", "Shop", etc.
  source_name         text         NULL,              -- raw Shopify `sourceName`
  items               integer      NOT NULL DEFAULT 0,
  tags                text[]       NOT NULL DEFAULT '{}',
  financial_status    text         NULL,              -- "PAID", "REFUNDED", etc.
  fulfillment_status  text         NULL,
  -- Money fields (in `currency`):
  subtotal            numeric(12,2) NOT NULL DEFAULT 0,
  discounts           numeric(12,2) NOT NULL DEFAULT 0,
  shipping            numeric(12,2) NOT NULL DEFAULT 0,
  tax                 numeric(12,2) NOT NULL DEFAULT 0,
  refunded            numeric(12,2) NOT NULL DEFAULT 0,
  total               numeric(12,2) NOT NULL DEFAULT 0,
  currency            text          NOT NULL DEFAULT 'USD',
  -- Bookkeeping
  synced_at           timestamptz   NOT NULL DEFAULT now(),
  raw                 jsonb         NULL,             -- (optional) original payload for debugging
  CONSTRAINT shopify_orders_unique UNIQUE (tenant_id, store_id, shopify_order_id)
);

-- Hot path: "give me all orders for store X on date Y" — the expand panel.
CREATE INDEX IF NOT EXISTS idx_shopify_orders_store_date
  ON shopify_orders (tenant_id, store_id, store_local_date DESC, created_at_shopify DESC);

-- For per-tenant rollups / range scans across stores.
CREATE INDEX IF NOT EXISTS idx_shopify_orders_tenant_date
  ON shopify_orders (tenant_id, store_local_date DESC);

-- For dedupe and idempotent upserts.
CREATE INDEX IF NOT EXISTS idx_shopify_orders_lookup
  ON shopify_orders (tenant_id, store_id, shopify_order_id);

ALTER TABLE shopify_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shopify_orders_tenant_isolation" ON shopify_orders;
CREATE POLICY "shopify_orders_tenant_isolation" ON shopify_orders
  FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() LIMIT 1));

COMMENT ON TABLE shopify_orders IS
  'Per-order Shopify detail. Populated by syncDailyOrders alongside the '
  'daily_orders aggregate. Powers the P&L day-expand panel and per-order '
  'analytics without live GraphQL calls.';

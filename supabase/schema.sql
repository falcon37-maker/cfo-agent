-- CFO Agent — Phase 1 schema
-- Falcon 37 LLC
-- Run against a fresh Supabase project (default `public` schema).

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- stores: registry of Shopify stores we pull from
-- id is the short human code (e.g. 'NOVA', 'KOVA'), used as FK everywhere.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists stores (
  id                        text primary key,
  name                      text not null,
  shop_domain               text not null unique,           -- e.g. nova-store.myshopify.com
  currency                  text not null default 'USD',
  timezone                  text not null default 'America/New_York',
  is_active                 boolean not null default true,
  -- Phase 1 P&L defaults (blended; refine per-SKU via `products.cogs` later)
  default_cogs_per_order    numeric(14,4) not null default 0,
  processing_fee_pct        numeric(6,4)  not null default 0,
  created_at                timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- daily_orders: one row per (store, date)
-- Aggregated from Shopify orders/refunds for that date in the store's tz.
-- Amounts stored in the store's currency.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists daily_orders (
  store_id        text not null references stores(id) on delete cascade,
  date            date not null,
  order_count     integer not null default 0,
  unit_count      integer not null default 0,
  gross_sales     numeric(14,2) not null default 0,     -- sum of line item subtotals (pre-discount)
  discounts       numeric(14,2) not null default 0,
  refunds         numeric(14,2) not null default 0,     -- refunded amount in the day
  shipping        numeric(14,2) not null default 0,
  tax             numeric(14,2) not null default 0,
  net_revenue     numeric(14,2) not null default 0,     -- gross_sales - discounts - refunds
  currency        text not null default 'USD',
  synced_at       timestamptz not null default now(),
  primary key (store_id, date)
);

create index if not exists daily_orders_date_idx on daily_orders(date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- daily_ad_spend: one row per (store, date, platform)
-- Platforms: 'meta', 'google', 'tiktok', etc. Populated by Phase 2.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists daily_ad_spend (
  store_id        text not null references stores(id) on delete cascade,
  date            date not null,
  platform        text not null,
  spend           numeric(14,2) not null default 0,
  impressions     bigint,
  clicks          bigint,
  currency        text not null default 'USD',
  synced_at       timestamptz not null default now(),
  primary key (store_id, date, platform)
);

create index if not exists daily_ad_spend_date_idx on daily_ad_spend(date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- products: per-store product/variant catalog with COGS
-- COGS is entered manually (or imported from supplier sheet) — Shopify doesn't
-- store it. Keyed by shopify_variant_id because that's what orders reference.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists products (
  store_id             text not null references stores(id) on delete cascade,
  shopify_variant_id   bigint not null,
  shopify_product_id   bigint not null,
  sku                  text,
  title                text,
  variant_title        text,
  cogs                 numeric(14,4),                  -- per-unit cost, nullable until set
  currency             text not null default 'USD',
  updated_at           timestamptz not null default now(),
  primary key (store_id, shopify_variant_id)
);

create index if not exists products_sku_idx on products(store_id, sku);

-- ─────────────────────────────────────────────────────────────────────────────
-- daily_pnl: one row per (store, date) — the final rollup we show on the dash
-- Populated by a computation job (Phase 1.5) that joins orders + ad spend +
-- per-variant COGS from that day's line items. Materialized rather than a view
-- so we can backfill historical COGS changes without rewriting raw orders.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists daily_pnl (
  store_id        text not null references stores(id) on delete cascade,
  date            date not null,
  revenue         numeric(14,2) not null default 0,     -- gross_sales from daily_orders (pre-discount, pre-refund)
  cogs            numeric(14,2) not null default 0,
  refunds         numeric(14,2) not null default 0,     -- from daily_orders.refunds
  ad_spend        numeric(14,2) not null default 0,     -- sum across platforms
  shipping_cost   numeric(14,2) not null default 0,     -- what we pay to ship (not charged)
  fees            numeric(14,2) not null default 0,     -- processor + Shopify fees
  gross_profit    numeric(14,2) not null default 0,     -- revenue - cogs
  net_profit      numeric(14,2) not null default 0,     -- gross_profit - ad_spend - shipping_cost - fees
  margin_pct      numeric(6,2),                         -- net_profit / revenue * 100
  order_count     integer not null default 0,           -- duplicated from daily_orders for display convenience
  computed_at     timestamptz not null default now(),
  primary key (store_id, date)
);

create index if not exists daily_pnl_date_idx on daily_pnl(date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- cogs_entries: audit log for manual COGS submissions via /cogs page
-- The authoritative COGS lives in daily_pnl.cogs; this is an append-only log.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists cogs_entries (
  id             uuid primary key default gen_random_uuid(),
  store_id       text not null references stores(id) on delete cascade,
  date           date not null,
  cogs           numeric(14,2) not null,
  submitted_by   text,
  submitted_at   timestamptz not null default now()
);

create index if not exists cogs_entries_recent_idx on cogs_entries(submitted_at desc);

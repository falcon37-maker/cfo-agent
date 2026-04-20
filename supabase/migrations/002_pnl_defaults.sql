-- Phase 1 P&L defaults.
-- Adds a blended per-order COGS + processing fee percentage to `stores`,
-- and a refunds column to `daily_pnl` so the dashboard can show it directly.

alter table stores
  add column if not exists default_cogs_per_order numeric(14,4) not null default 0,
  add column if not exists processing_fee_pct     numeric(6,4)  not null default 0;

alter table daily_pnl
  add column if not exists refunds numeric(14,2) not null default 0;

-- NOVA defaults (to refine per-SKU later)
update stores
   set default_cogs_per_order = 15.0000,
       processing_fee_pct     = 0.1000
 where id = 'NOVA';

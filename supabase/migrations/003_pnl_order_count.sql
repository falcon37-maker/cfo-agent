-- Lets the manually-tracked NOVA sheet (which has per-day order counts) drive
-- the dashboard directly from daily_pnl, without needing to join daily_orders.

alter table daily_pnl
  add column if not exists order_count integer not null default 0;

-- NOVA's actual processor rate is 7%, not the 10% placeholder used initially.
update stores set processing_fee_pct = 0.0700 where id = 'NOVA';

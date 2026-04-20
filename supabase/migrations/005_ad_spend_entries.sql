-- Audit log of manual ad-spend submissions from the /ads page.
-- Authoritative ad spend lives in daily_ad_spend (platform='facebook'); this
-- table lets the entry page show "last N submissions" without exposing P&L.

create table if not exists ad_spend_entries (
  id             uuid primary key default gen_random_uuid(),
  store_id       text not null references stores(id) on delete cascade,
  date           date not null,
  amount         numeric(14,2) not null,
  submitted_by   text,
  submitted_at   timestamptz not null default now()
);

create index if not exists ad_spend_entries_recent_idx
  on ad_spend_entries (submitted_at desc);

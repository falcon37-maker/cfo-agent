-- Audit log of manual COGS submissions from the /cogs page.
-- The authoritative COGS lives in daily_pnl.cogs; this table lets the form
-- show "last N submissions" for confirmation, without exposing the full P&L.

create table if not exists cogs_entries (
  id             uuid primary key default gen_random_uuid(),
  store_id       text not null references stores(id) on delete cascade,
  date           date not null,
  cogs           numeric(14,2) not null,
  submitted_by   text,
  submitted_at   timestamptz not null default now()
);

create index if not exists cogs_entries_recent_idx
  on cogs_entries (submitted_at desc);

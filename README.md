# CFO Agent — Falcon 37

Finance operations dashboard for Falcon 37 LLC. Consolidates two revenue
engines into a single daily P&L:

1. **Shopify storefronts** (dropshipping) — NOVA, NURA, KOVA, ELARA, SOLEN, VOLEN
2. **Subscriptions** — billed via **Phoenix (Solvpath)** and **Paysight** CRMs

Pulls live orders + subscription charges, blends in manually-entered ad spend
and COGS, and produces per-store and consolidated daily P&L (revenue, gross
profit, net profit, ROAS, margin) plus a subscription view.

> For the full project history, phases, and roadmap see
> [`PROJECT_STATUS.md`](./PROJECT_STATUS.md).

## Stack

- **Next.js 16** App Router, TypeScript
- **Supabase** (Postgres) — service role on the server only; RLS for tenant isolation
- **Vercel** hosting (Pro — for the hourly cron + >2 cron jobs)
- **Shopify Admin API** (GraphQL `2025-01`) — static-token + OAuth client-credentials
- **Solvpath / Phoenix** + **Paysight** APIs for subscriptions

## Key routes

| Path | Purpose |
|---|---|
| `/` | Dashboard: KPIs, revenue pulse chart, subscription engine, blended daily P&L |
| `/pnl` | Per-store daily ledger (expandable to Shopify orders) + CSV export + **Sync Data** button |
| `/subscriptions` | Phoenix + Paysight subscription ledger and KPIs |
| `/settings` | Stores (add/edit/test connection), integrations, COGS, rules |
| `/cogs`, `/ads` | Mobile forms for daily COGS / ad-spend entry |

### Sync APIs

| Path | Auth | Purpose |
|---|---|---|
| `/api/cron/sync-hourly` | `CRON_SECRET` | Hourly: last 3 days, all sources (Shopify + Paysight + Phoenix counts) |
| `/api/cron/sync-daily-full` | `CRON_SECRET` | Daily: prev-month-start → today full backfill, all sources |
| `/api/sync/manual` | session | User-triggered (the Sync Data button) — re-pull a chosen date/range |
| `/api/sync/paysight`, `/api/sync/solvpath` | `CRON_SECRET` | Per-source manual triggers (ping / sync / range) |
| `/api/stores/test-connection` | session | Live-pings a store's Shopify creds (Connected / Invalid / Needs token) |
| `/api/pnl/day-orders` | session | Orders behind a ledger day (powers the expand panel; reads `shopify_orders`) |
| `/api/export/pnl` | session | CSV download of the P&L ledger |

## P&L formula

```
# Shopify side (per store-day, from daily_orders → daily_pnl)
revenue      = gross_sales − refunds          # = Shopify "Net sales"
cogs         = order_count × default_cogs_per_order
fees         = revenue × processing_fee_pct
gross_profit = revenue − cogs
net_profit   = revenue − cogs − fees − ad_spend

# Subscription blend (NOVA / NURA / KOVA)
# Source = Paysight preferred, Phoenix fallback (per date) — subscriptions
# migrated Phoenix→Paysight Jun 2026, so we use whichever has data, never sum.
subs_revenue       = Initial + Recurring + Salvage  (Paysight charges, or Phoenix)
total_revenue      = revenue + upsell + subs_revenue
subs_contribution  = subs_revenue × (1 − fee_rate)
net_profit        += subs_contribution
margin_pct         = net_profit / total_revenue × 100

# Order count display
orders shown = Shopify orders only; subscriptions shown as a "+N subs" badge
```

## Credentials & security

- Shopify tokens / Paysight API key are **encrypted at rest** (AES-256-GCM) in
  the `stores` / `integrations` tables. Never sent to the browser.
- `CREDENTIAL_ENCRYPTION_KEY` decrypts them — **never lose it** (rotating means
  decrypt-all-with-old → re-encrypt-with-new).
- `SUPABASE_SERVICE_ROLE_KEY` is server-only.
- Runtime credential resolution is **DB-first** (env-var fallback removed Jun 2026).

## Core tables

- `stores` — registry + per-store fee/COGS defaults + encrypted Shopify creds
- `daily_orders` — per-store/day Shopify aggregate
- `shopify_orders` — per-order Shopify detail (powers the expand panel)
- `daily_pnl` — per-store/day P&L rollup (authoritative for the dashboard)
- `phx_summary_snapshots` — Phoenix/Solvpath per-day subscription revenue + counts
- `paysight_transactions`, `paysight_subscriptions` — Paysight per-row data
- `daily_ad_spend`, `cogs_entries`, `ad_spend_entries` — manual entry + audit
- `integrations` — per-tenant encrypted Solvpath / Paysight / Chargeblast creds
- `data_validation_log` — anomalies surfaced as the dashboard warning banner

Schema lives in `supabase/schema.sql`; incremental changes in
`supabase/migrations/*.sql` (apply in order; `scripts/apply-migration-*.mjs`).

## Local setup

```bash
npm install
# create .env with the vars below
npm run dev
```

## Env vars

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Supabase project URL + publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role (server-only) |
| `DATABASE_URL` | Direct Postgres (edit-mode writes + migration/backfill scripts) |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256 key for token encryption — **critical** |
| `SHOPIFY_API_VERSION` | Pinned to `2025-01` |
| `CRON_SECRET` | Authenticates Vercel cron requests |
| `SOLVPATH_BASE_URL` / `_PARTNER_ID` / `_PARTNER_TOKEN` / `_BEARER_TOKEN` | Phoenix |
| `PAYSIGHT_BASE_URL` / `_CLIENT_ID` / `_USER_EMAIL` / `_API_KEY` | Paysight |
| `ANTHROPIC_API_KEY` / `_MODEL` / `_MAX_TOKENS` | AI chat |

Shopify per-store credentials live in the **DB** (Settings → Stores → Edit),
not env vars. Add a new store from the UI — no code changes needed.

## Deploy to Vercel

1. Import the repo in Vercel (Pro plan for hourly cron).
2. Add every env var above in Project → Settings → Environment Variables
   (Production + Preview + Development). **`CREDENTIAL_ENCRYPTION_KEY` and the
   `PAYSIGHT_*` / `SOLVPATH_*` keys are required** for sync to work.
3. Deploy. Crons (`vercel.json`) start automatically:
   - `sync-hourly` — every hour
   - `sync-daily-full` — daily 06:30 UTC
   - `data-validation` — daily 15:30 UTC

## Conventions

- Store codes are uppercase and match `stores.id`.
- Backend day-bucketing + Shopify queries use each store's IANA timezone;
  frontend P&L order times render in store-tz (Shopify-Admin parity).
- Shopify GraphQL search timestamps **must be single-quoted** (embedded `:`
  otherwise breaks the date filter — see `feedback-shopify-query-quoting`).
- `daily_pnl` is authoritative for the dashboard; `daily_orders` is raw aggregation.
- Currency formatted at render time — never round server-side.
- `.env*` is gitignored. Never commit secrets.

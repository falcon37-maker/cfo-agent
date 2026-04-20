# CFO Agent — Falcon 37

Daily P&L + finance operations dashboard for Falcon 37 LLC's Shopify stores (NOVA, NURA, KOVA). Aggregates orders from Shopify + manually-entered ad spend + manually-entered COGS into a single daily P&L surface.

## Stack

- **Next.js 16** App Router, TypeScript, Tailwind v4
- **Supabase** (Postgres) — service role on the server only
- **Vercel** hosting
- **Shopify Admin API** (GraphQL, `2025-01`) for orders
- Manual entry pages for ad spend (`/ads`) and COGS (`/cogs`), password-gated

## Routes

| Path | Purpose |
|---|---|
| `/` | Dashboard: today KPIs, revenue-vs-ad-spend chart, store mix donut, 10d consolidated P&L |
| `/pnl` | Filtered daily ledger + totals + CSV export |
| `/settings` | Stores panel, rules panel (read-only) |
| `/cogs` | Mobile password-gated form for Lara to enter daily COGS per store |
| `/ads` | Mobile password-gated form for Lara to enter daily ad spend per store |
| `/subscriptions`, `/cash`, `/accounting` | Stubs (Phase C — need Phoenix / Plaid / QuickBooks) |
| `/api/sync/today?store=XXX` | Pull today's Shopify orders for one store |
| `/api/sync/backfill?store=XXX&days=N` | Pull N days of Shopify orders + compute daily P&L |
| `/api/import/csv?store=XXX` | One-time import of the historical Google-Sheet CSVs |
| `/api/export/pnl?range=30d&store=all` | CSV download of the P&L ledger |
| `/api/compute/pnl?store=XXX&date=YYYY-MM-DD` | Recompute P&L for a specific day |

## P&L formula

```
revenue      = daily_orders.gross_sales (or CSV Revenue)
cogs         = CSV Product Cost, OR manual /cogs entry, OR order_count × stores.default_cogs_per_order
fees         = revenue × stores.processing_fee_pct (currently 10%)
refunds      = daily_orders.refunds
ad_spend     = Σ daily_ad_spend rows (manual entries via /ads, platform='facebook')
gross_profit = revenue − cogs
net_profit   = revenue − cogs − fees − refunds − ad_spend
margin_pct   = net_profit / revenue × 100
```

## Schema

See `supabase/schema.sql` for the full create-from-scratch and `supabase/migrations/*.sql` for incremental changes. Run them in order in the Supabase SQL editor.

Core tables:
- `stores` — store registry + per-store defaults (fee rate, blended COGS)
- `daily_orders` — per-store/day aggregates from Shopify
- `daily_ad_spend` — per-store/day/platform (CSV-imported `facebook`, manual entries also `facebook`)
- `products` — per-variant COGS (Phase A next pass)
- `daily_pnl` — per-store/day rollup, authoritative for the dashboard
- `cogs_entries`, `ad_spend_entries` — audit logs for manual submissions

## Local setup

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

Apply migrations in order: `supabase/migrations/002_pnl_defaults.sql` → `003_pnl_order_count.sql` → `004_cogs_entries.sql` → `005_ad_spend_entries.sql`.

## Env vars

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-only — bypasses RLS) |
| `SHOPIFY_API_VERSION` | Pinned to `2025-01` |
| `NOVA_DOMAIN`, `NOVA_TOKEN` | `f1ynhw-g0.myshopify.com` + `shpat_…` (scopes: `read_orders, read_products, read_inventory, read_customers`) |
| `NURA_DOMAIN`, `NURA_TOKEN` | same for NURA |
| `KOVA_DOMAIN`, `KOVA_TOKEN` | same for KOVA |
| `COGS_PAGE_PASSWORD` | Shared password for `/cogs` and `/ads` |

Add new stores with just two env pairs (`<CODE>_DOMAIN`, `<CODE>_TOKEN`) + a row in `stores` — no code changes required.

## Deploy to Vercel

1. Import this repo in Vercel.
2. Copy every env var above into Project → Settings → Environment Variables (Production + Preview).
3. Deploy. No build-step tweaks needed — `npm run build` works out of the box.
4. Point `cfo-agent.ai` at the Vercel project (Settings → Domains).

## Conventions

- Store codes are uppercase (`NOVA`) and match `stores.id`.
- Currency formatting: `Intl.NumberFormat` at render time — **never** round server-side.
- `daily_pnl` is authoritative for the dashboard; `daily_orders` is raw Shopify aggregation only.
- `.env*` files are gitignored. Don't commit any secrets.

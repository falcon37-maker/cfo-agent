# CFO Agent — Project Status & Roadmap

_Finance operations dashboard for Falcon 37 LLC — Shopify dropshipping + PHX (Phoenix) subscription business._

Last updated: **June 2026**

---

## 1. What This Project Is

A single dashboard ("CFO Agent / Finance OS") that consolidates the company's
money picture across two revenue engines:

1. **Shopify storefronts** (dropshipping) — NOVA, NURA, KOVA, ELARA, SOLEN, VOLEN, …
2. **PHX subscriptions** (recurring billing via Solvpath/Phoenix) — Initial + Recurring + Salvage charges

It pulls live order data from Shopify, blends in subscription revenue, applies
COGS / fees / ad spend, and produces a daily P&L (revenue, gross profit, net
profit, ROAS, margin) per store and consolidated.

**Tech stack:** Next.js 16 (App Router, TypeScript) · Supabase (Postgres) ·
Shopify Admin API (GraphQL `2025-01`) · Vercel hosting.

---

## 2. Client Requirements (from discussions)

| # | Requirement | Status |
|---|---|---|
| R1 | Daily P&L per store, matching Shopify Admin exactly | ✅ Done |
| R2 | Blend PHX subscription revenue into the per-store P&L | ✅ Done |
| R3 | Expandable daily ledger — click a day to see the underlying Shopify orders | ✅ Done |
| R4 | Store order details in our own DB (not just live Shopify calls) | ✅ Done |
| R5 | Timezone correctness — buckets in store-tz, display per spec | ✅ Done |
| R6 | Multi-store, multi-tenant with secure credential storage | ✅ Done |
| R7 | Support both Shopify auth types (static token + OAuth) | ✅ Done |
| R8 | Settings UI to add / edit / test stores without code changes | ✅ Done |
| R9 | Data validation + warnings for missing / anomalous data | ✅ Done (banner live) |
| R10 | Phoenix ↔ Paysight data sync | ⏳ **Next phase** (client requested Jun 2026) |
| R11 | Re-enable dropshipping stores (NEEDOH, NOVA-2nd, etc.) | ⏸️ Deferred ~1 month (client paused dropshipping) |

---

## 3. Phases

### ✅ Phase 1 — Core Dashboard (DONE)
- Daily ledger, KPI tiles, store-mix donut, revenue-vs-ad-spend chart
- Per-store P&L with date-range + store filters
- CSV export
- Manual entry pages for COGS (`/cogs`) and Ad Spend (`/ads`)

### ✅ Phase 2 — Data Accuracy (DONE)
- **Shopify formula alignment**: `revenue` now exactly matches Shopify Admin →
  Analytics → Sales Report ("Net sales" = gross − discounts − refunds)
- **Timezone auto-fetch**: pulls each shop's real IANA timezone from Shopify on
  every sync; day-buckets align with what the merchant sees
- **Data validation system**: dashboard banner flags missing recurring subs,
  missing credentials, missing PHX snapshots, negative revenue, etc.
- **SOLEN reconciliation**: cleaned up duplicate / wrong-timezone rows against
  the merchant's Shopify CSV

### ✅ Phase 3 — Order Detail + Expand Panel (DONE)
- New `shopify_orders` table storing every individual order (id, customer,
  channel, items, tags, payment/fulfillment status, all money fields)
- P&L ledger rows are expandable → shows that day's orders in a Shopify-Admin-style
  table with pagination, status pills, channel + tags columns
- Expand panel reads from our DB (fast, no live API calls, no rate limits)
- Order count split: parent row shows **Shopify orders + PHX subs badge** so the
  parent count matches the expand panel exactly

### ✅ Phase 4 — Critical Sync Bug Fix + Full Resync (DONE)
- **Root cause found**: Shopify GraphQL search queries embed `:` in ISO
  timestamps; without single-quoting the value, Shopify's parser dropped the
  upper date bound → half-infinite window → inflated order counts (e.g. KOVA
  May 31 showed 101 orders / $3,378 instead of the correct 48 / $1,559)
- **Fix**: single-quote all timestamp values in Shopify search queries
- **Cron hardened**: daily sync now uses a 3-day rolling window (today +
  yesterday + day-before) so cross-midnight boundary orders and late
  refunds/cancellations self-correct
- **Full historical resync**: 60–90 days re-pulled for all active stores
- **Verified**: 100% match between DB and live Shopify Admin across dozens of
  sampled (store, date) checks

### ✅ Phase 5 — Credential Migration (env → DB) (DONE)
- Shopify tokens **moved from `.env` files into the encrypted `stores` table**
  (AES-256-GCM, key in `CREDENTIAL_ENCRYPTION_KEY`)
- Runtime code is now **DB-only** — env-var fallback removed everywhere
- **Both auth modes supported & verified live**:
  - Static token (`shpat_…`) — NOVA, NURA, KOVA
  - OAuth client-credentials — ELARA, SOLEN, VOLEN
- **Settings UI redesign**: slide-in drawer for add/edit, live "Connected /
  Invalid token / Needs token" status per store, per-store "Test connection"
  and "View orders" actions, professional card layout
- Token rotation now possible from the UI (no code deploy)

### ✅ Phase 6 — Phoenix ↔ Paysight Sync (DONE — Jun 8 2026)
Client confirmed **Option A**: both Phoenix and Paysight feed the CFO Agent
dashboard for a combined subscription view (they don't sync to each other
directly). Paysight is a subscription/payment CRM like Phoenix/ApexGateway.

- **Phoenix (Solvpath)**: live credentials added (`partnerId 280` + tokens);
  revenue pipeline verified end-to-end.
- **Paysight**: built from scratch in one day.
  - Decoded the API (auth = raw key in `Authorization` + `ClientId` + `UserEmail`
    headers; base `https://test.paysight.io`; endpoints
    `/api/mitigation/subscriptions` + `/api/mitigation/transactions`).
  - New tables `paysight_transactions` + `paysight_subscriptions`
    (migration 019).
  - `src/lib/paysight/{client,sync,queries}.ts` — pull, store-map (descriptor →
    NOVA/NURA/KOVA), upsert, dashboard rollup.
  - `/api/sync/paysight` (ping/sync/range) + `/api/cron/paysight-daily`
    (3-day rolling window, scheduled 08:15 UTC in vercel.json).
  - Backfilled 10 days (all that exists in the test env): 405 subscriptions,
    917 transactions. **Verified 89/89 transactions match the Paysight
    dashboard** for Jun 8.
  - Surfaced on `/subscriptions` as a "Paysight · CRM" card (revenue,
    active subscribers, txn counts, per-store breakdown).

**Open items for Phase 6:**
- Confirm Paysight **production** API URL (we're on `test.paysight.io`).
- Add a Paysight card to Settings → Integrations (currently env-configured).

### ✅ Phase 6b — Migration blend + manual sync + cron rework (DONE — Jun 10 2026)
Evidence from the data (and confirmed by inspection): subscriptions **migrated
Phoenix → Paysight around Jun 6 2026**. Phoenix's transaction-history has no
Jun 6/7/9/10 data; Paysight has full activity those days.

- **Migration blend**: the subscription bucket now uses **Paysight preferred,
  Phoenix fallback** per date — on any day Paysight has data we use it,
  otherwise Phoenix. No double-count (never summed), no migration gap. Applied
  consistently across all three surfaces:
  - Dashboard `/` blended table (`loadBlendedDashboardData`)
  - Stores `/pnl` ledger (`loadPnlLedger`)
  - Subscriptions `/subscriptions` ledger (`buildLedger`)
  - New helper: `loadPaysightSubsByDate()` in `src/lib/paysight/queries.ts`.
  - Verified live (Playwright): Jun 6/7/9/10 Subs Rev now populated; previously
    red-negative rows are green again.
- **Manual "Sync Data" button** on `/pnl`: opens a modal with single-date or
  date-range picker, re-pulls that window from Shopify + Paysight + Phoenix on
  demand (`/api/sync/manual`, session-authed, 31-day cap). Built because data
  can look "missing" simply when new transactions land after the last sync.
- **Cron rework** (replaces the per-source crons):
  - `/api/cron/sync-hourly` (`0 * * * *`) — last 3 days, all sources.
  - `/api/cron/sync-daily-full` (`30 6 * * *`) — prev-month-start → today full
    backfill, all sources; Phoenix revenue walk is chunked + time-boxed and
    resumes across fires.

### ⏸️ Phase 7 — Dropshipping Re-enable (DEFERRED ~1 month)
- Client paused dropshipping to focus on subscriptions
- When they return: provide remaining store tokens (NEEDOH and one other were
  requested but deferred), wire them into the same DB-credential flow
- No code changes needed — just add the store row + paste the token in Settings

---

## 4. Current Store Status (June 2026)

| Store | Auth Type | Connected | Notes |
|---|---|---|---|
| **NOVA** | Static token | ✅ | NOVA USA · America/New_York |
| **NURA** | Static token | ✅ | America/New_York |
| **KOVA** | Static token | ✅ | America/New_York |
| **ELARA** | OAuth | ✅ | Shop name "UNIFIED RETAIL" |
| **SOLEN** | OAuth | ✅ | America/**Bogota** (Colombia) |
| **VOLEN** | OAuth | ✅ | America/New_York |
| NEEDOH | — | ❌ | Dead store / historical import only; token deferred |
| ELEGIAR, VELLEDO, NILORA, CLENZY, CASHVAULT, BEAVENTOS | OAuth (legacy) | ⚠️ | Secrets in DB but encrypted with the production key — can't decrypt locally; not active |

> **Note on OAuth stores:** ELARA / SOLEN / VOLEN apps lack the `read_customers`
> scope, so customer name/email aren't stored. All financial data (order count,
> revenue, tags, payment status, channel) syncs correctly.

---

## 5. How the Data Flows

```
Shopify storefront
      │  (static token OR OAuth client-credentials)
      ▼
ShopifyClient.graphql()  ──────────────►  shopify_orders   (per-order detail)
      │                                          │
      │                                          ▼
      └──────────────────────────────►  daily_orders   (per-day aggregate)
                                                 │
PHX / Solvpath  ──► phx_summary_snapshots ───────┤
                                                 ▼
                                          daily_pnl  (revenue, profit, ROAS, margin)
                                                 │
                                                 ▼
                                          Dashboard  /  /pnl  ledger
```

**Timezone rule:** Backend day-bucketing + Shopify queries use each store's IANA
timezone (from Shopify). DB timestamps are UTC. See `MEMORY` /
`feedback-timezone-strategy` for the full policy.

---

## 6. Key P&L Formulas

```
# Shopify side (per store-day)
revenue        = daily_orders.gross_sales − daily_orders.refunds   (= Shopify "Net sales")
cogs           = order_count × stores.default_cogs_per_order
fees           = revenue × stores.processing_fee_pct
shopify_gross  = revenue − cogs
shopify_net    = revenue − cogs − fees − ad_spend

# PHX subscription blend (for PHX stores)
phx_revenue       = phx.subs + phx.upsell        (Initial + Recurring + Salvage)
phx_contribution  = phx_revenue × (1 − fee_rate)

# Final dashboard columns
ORDERS        = shopify orders  + "+N subs" badge (PHX rebills)
REVENUE       = revenue + phx.upsell
SUBS REV      = phx.subs
GROSS PROFIT  = shopify_gross + phx_revenue
NET PROFIT    = shopify_net + phx_contribution
MARGIN %      = net_profit / total_revenue × 100
ROAS          = total_revenue / ad_spend
```

---

## 7. Security Notes

- Shopify tokens / OAuth secrets are **encrypted at rest** (AES-256-GCM) in the
  `stores` table. They are never sent to the browser — the Settings form only
  shows "saved" / "not configured" state and accepts new values to overwrite.
- `CREDENTIAL_ENCRYPTION_KEY` must never be lost — it's the only way to decrypt
  stored tokens. To rotate it, decrypt all with the old key and re-encrypt.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only (bypasses RLS). Never exposed client-side.
- `.env` is gitignored.

---

## 8. Outstanding / Known Items

- [ ] **Deploy latest code + env vars to Vercel** — Paysight integration,
      migration blend, sync button, and the reworked crons are verified locally
      but need a deploy. Production env must include `CREDENTIAL_ENCRYPTION_KEY`,
      `PAYSIGHT_*`, `SOLVPATH_*`, and `ANTHROPIC_*` or sync + AI chat will fail.
- [ ] **Paysight production URL** — currently on `test.paysight.io`; confirm
      with client and switch `PAYSIGHT_BASE_URL`.
- [ ] **Legacy OAuth stores** (ELEGIAR, VELLEDO, etc.) — re-encrypt their secrets
      with the current key if they need to go active.
- [ ] **Dropshipping re-enable** — deferred ~1 month per client (Phase 7).
- [ ] `read_customers` scope on OAuth apps — optional, only needed if customer
      name/email must appear in the expand panel for ELARA/SOLEN/VOLEN.
- [ ] **Phoenix `revenue_recurring` shows $0** on recent days — under
      investigation; likely the Phoenix transaction-history simply has no
      recurring rows for migrated subscribers (they rebill on Paysight now).
      The migration blend already surfaces the correct Paysight revenue, so
      this no longer affects the dashboard totals.

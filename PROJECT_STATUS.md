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

### ⏳ Phase 6 — Phoenix ↔ Paysight Sync (NEXT)
- Client requested this in June 2026 as the next priority
- **Blocked on**: Paysight API access / credentials, data-flow spec, direction
- Scope to define: which entities sync (subscriptions, billing events,
  chargebacks), one-way or bidirectional, frequency

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

- [ ] **Phoenix ↔ Paysight sync** — awaiting Paysight access + spec (Phase 6)
- [ ] **Deploy latest code to Vercel** — the sync bug fix + DB-credential code is
      verified locally; production cron still needs the deploy to stop the
      nightly re-introduction of the old bug
- [ ] **Legacy OAuth stores** (ELEGIAR, VELLEDO, etc.) — re-encrypt their secrets
      with the current key if they need to go active
- [ ] **Dropshipping re-enable** — deferred ~1 month per client (Phase 7)
- [ ] `read_customers` scope on OAuth apps — optional, only needed if customer
      name/email must appear in the expand panel for ELARA/SOLEN/VOLEN

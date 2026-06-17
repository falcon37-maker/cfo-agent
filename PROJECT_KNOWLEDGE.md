# CFO Agent — Project Knowledge

**A plain-English guide to how the dashboard works:** where the data comes
from, how it's processed and displayed, how the calculations are done, how
often everything syncs, and how much data each source holds.

_Prepared for Falcon 37 LLC · June 2026_

---

## 1. What this dashboard does

The CFO Agent pulls together **two revenue engines** into one daily financial
picture:

1. **Shopify storefronts** (the online stores) — KOVA, NOVA, NURA, ELARA,
   SOLEN, VOLEN, NEEDOH.
2. **Subscriptions** — the recurring VIP membership billing, handled by two
   CRMs: **Phoenix (Solvpath)** and **Paysight**.

It blends in manually-entered ad spend and COGS, and produces a per-store and
consolidated daily P&L (revenue, profit, ROAS, margin) plus a dedicated
subscription view.

---

## 2. Where the data comes from (the 3 sources)

| Source | What it gives us | How we connect |
|---|---|---|
| **Shopify** | Store orders + revenue (per store, per day) | Shopify Admin API (GraphQL), one secure token per store |
| **Phoenix (Solvpath)** | VIP subscription billing — older subscribers | Phoenix API (partner credentials), customer-by-customer |
| **Paysight** | VIP subscription billing — newer subscribers (post-migration) | Paysight Admin API (API key) |

**Why two subscription sources?** The VIP subscriptions were **migrated from
Phoenix to Paysight in early June 2026**. So Phoenix holds the older
subscribers (still rebilling now), and Paysight holds the newer ones. It's the
**same subscription business**, just split across two platforms during the
transition. We combine both — no double-counting, because each subscriber bills
on exactly one platform.

---

## 3. How the data flows (source → screen)

```
  LIVE SOURCES            OUR DATABASE              DASHBOARD
  ─────────────           ────────────              ─────────
  Shopify API    ──┐
  Phoenix API    ──┼──►  Sync jobs pull   ──►  Stored, de-duplicated  ──►  Calculations  ──►  Charts,
  Paysight API   ──┘     the data              & timezone-bucketed         & blending          tables, KPIs
```

1. **Sync jobs** call each live source and pull the latest data.
2. Data is **stored in our database**, de-duplicated, and bucketed into the
   correct calendar day (in the store's local timezone — see §6).
3. When you open a page, the dashboard **reads from the database** (fast),
   runs the calculations, and renders the charts/tables.

Nothing is typed in by hand except ad spend and COGS — all revenue numbers come
straight from the live sources.

---

## 4. How the numbers are calculated

### Store revenue (Shopify)
```
revenue      = gross sales − refunds        (= Shopify "Net sales")
cogs         = orders × cost-per-order       (your configured COGS)
fees         = revenue × processing-fee %
gross profit = revenue − cogs
net profit   = revenue − cogs − fees − ad spend
```

### Subscription revenue ("Subs Rev") — BILLED only
Per your spec, Subs Rev counts only what was **billed that day** to
subscribers — not newly-acquired checkout orders:

```
Subs Rev = Phoenix billed (Initial + Recurring + Salvage)
         + Paysight rebills (recurring charges only)

  • New      = Initial enrollments (a subscriber's first charge)
  • Rebill   = Recurring monthly charges + Salvage (recovered failed payments)
```

The Subscriptions page now shows **New** and **Rebill** as separate columns so
you can see exactly how much of each day is new sign-ups vs. existing-member
rebills.

### Total Revenue (consolidated)
```
Total Revenue = all-store Shopify checkout + billed Subs Rev + manual revenue
```

### Important: new checkout vs. billed subscription
- A customer's **first/new purchase** = store revenue (Shopify side).
- A **monthly rebill** of an existing subscriber = Subs Rev.
- This keeps the two from double-counting the same dollars.

---

## 5. What's displayed (the pages)

| Page | What it shows |
|---|---|
| **Dashboard** | KPI cards (Total Revenue, Ad Spend, Net Profit, ROAS), revenue trend chart, store-revenue donut, billed-subscriptions chart, subscription engine, and the blended daily P&L |
| **Stores (P&L)** | Per-store daily ledger — orders, revenue, Subs Rev, ad spend, COGS, fees, profit. Filter by store + date range, export to CSV |
| **Subscriptions** | Daily subscription ledger split into **New** vs **Rebill**, plus subscriber counts and KPIs |
| **Finance** | Cash signal — gross vs. net after fees/chargebacks, monthly trend |
| **Chargebacks** | Alerts and real chargebacks over time |
| **Settings** | Stores, integrations, COGS, rules |

All pages use a professional dark theme with interactive charts (hover for
exact figures), capped at a comfortable max width and fully responsive on
smaller screens.

---

## 6. Timezones (why a day is "a day")

- **Shopify** buckets orders in each store's **local timezone** (US Eastern).
- **Paysight & Phoenix** timestamps are UTC — we **convert them to the store's
  local timezone** before deciding which day they belong to.

This means a late-evening Eastern order isn't accidentally pushed to the next
calendar day. All three sources line up on the same store-local day, exactly as
they appear in Shopify Admin.

---

## 7. Sync schedule (how often, how long)

Data refreshes automatically on a schedule — you don't have to do anything.
There's also a manual **"Sync Data"** button on the Stores and Subscriptions
pages (with a live progress bar) if you ever want to refresh a specific date on
demand.

| Sync | Runs | Covers | Typical time |
|---|---|---|---|
| **Hourly** | Every hour | Last 3 days — Shopify + Paysight + subscriber counts | A few minutes |
| **Daily full** | Once daily (early morning) | Previous month → today, full reconciliation incl. Phoenix revenue | See below |
| **Data validation** | Once daily | Checks for anomalies (surfaced as the dashboard warning banner) | Under a minute |

### Why Phoenix takes longer
- **Shopify** sync: fast — a few seconds per store-day.
- **Paysight** sync: fast — a few seconds per day (bulk API).
- **Phoenix** sync: **the slow one** — Phoenix has no "give me a day's total"
  endpoint, so we walk **every subscriber one-by-one** (~5,700 customers) and
  add up their charges per day. A full Phoenix revenue refresh takes
  **~30–40 minutes**. It runs in the background and resumes where it left off,
  so it never blocks the dashboard. Recent subscriber counts stay fresh via the
  hourly sync in the meantime.

---

## 8. How much data each source holds (live counts)

| Data | Volume | What it is |
|---|---|---|
| Active stores | **7** | KOVA, NOVA, NURA, ELARA, SOLEN, VOLEN, NEEDOH |
| Shopify orders (detail) | **~4,700** | Individual orders behind the ledger |
| Daily P&L rows | **~835** | One per store, per day (the authoritative rollup) |
| Daily store aggregates | **~700** | Per-store/day Shopify totals |
| Paysight transactions | **~2,600** | Individual subscription charges |
| Paysight active subscriptions | **~1,200** | Newer VIP members (post-migration) |
| Phoenix snapshots | **~460** | Per-day subscription billing rollups |
| **Active subscribers (Phoenix)** | **~3,785** | Current VIP members on Phoenix |
| Cancelled subscribers (Phoenix) | **~1,931** | Historical cancellations |

_(Volumes grow daily as new orders and charges come in.)_

---

## 9. Verifying the data yourself

Every number is traceable back to its live source:

- **Paysight** — export a day's transactions from the Paysight dashboard
  (Transactions → date + store + Success), and it will match our database
  exactly (verified repeatedly).
- **Shopify** — a store's Shopify Admin "Net sales" for a day matches our
  Revenue column.
- **Phoenix** — a Solvpath transaction export (Capture/SUCCESS rows) matches
  our Initial + Recurring + Salvage billing.

The full chain — **live source → database → dashboard display** — has been
cross-checked and lines up at every step.

---

## 10. Security

- All store tokens and the Paysight API key are **encrypted at rest** and never
  sent to the browser.
- Each store's credentials live in the database; new stores can be added from
  Settings with no code changes.
- Access is tenant-isolated — your data is only visible to your account.

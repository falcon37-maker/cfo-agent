// /subscriptions — Overview tab.
// Daily ledger (Initial + Recurring + Salvage from PHX) + lifetime KPI strip
// + transaction-type Order Mix.

import Link from "next/link";
import { Users, CreditCard, Target, Activity, TrendingDown } from "lucide-react";
import {
  loadLatestPortfolioSnapshot,
  loadPhxDailyRows,
  type PhxSnapshot,
} from "@/lib/phx/queries";
import { loadPaysightSubsByDate } from "@/lib/paysight/queries";
import { loadStores, loadBlendedDashboardData } from "@/lib/pnl/queries";
import { BlendedPnlTable } from "@/components/dashboard/BlendedPnlTable";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fmtDate, fmtInt, fmtMoney, fmtPct } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { computeCohortChurn } from "@/lib/phx-cohort/churn";
import { SegLink } from "@/components/pnl/SegLink";
import { SubsDateRange } from "@/components/subscriptions/SubsDateRange";
import { SyncDataButton } from "@/components/pnl/SyncDataButton";
import { TableFooter } from "@/components/subscriptions/TableFooter";
import { SubsSearchInput } from "@/components/subscriptions/SubsTableSearch";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscriptions — CFO Agent" };

const PHX_STORE_IDS = new Set(["NOVA", "NURA", "KOVA"]);
// Subscription processing fee ~16% of billed revenue (client spec, Jun 2026).
const SUBS_FEE_RATE = 0.16;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGES: Array<{ id: string; days: number }> = [
  { id: "7d", days: 7 },
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function qs(p: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}
function parseStoreList(raw: string): string[] {
  if (!raw || raw.toLowerCase() === "all") return [];
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}
function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

type DailyPnlRow = {
  store_id: string;
  date: string;
  ad_spend: number | string | null;
  cogs: number | string | null;
  fees: number | string | null;
};

async function loadDailyPnl(
  from: string,
  to: string,
  storeIds: string[],
  tenantId: string,
): Promise<DailyPnlRow[]> {
  const sb = supabaseAdmin();
  let q = sb
    .from("daily_pnl")
    .select("store_id, date, ad_spend, cogs, fees")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to);
  if (storeIds.length > 0) q = q.in("store_id", storeIds);
  const { data } = await q;
  return (data ?? []) as DailyPnlRow[];
}

type LedgerRow = {
  date: string;
  orders: number;
  revenue: number;
  new_rev: number; // Initial enrollments (new subscribers' first charge)
  new_count: number; // Count of initial enrollments (Subscription Build)
  rebill_rev: number; // Recurring + Salvage (re-charges of existing subs)
  ad_spend: number;
  cogs: number;
  fees: number;
  gross_profit: number;
  net_profit: number;
  roas: number;
};

function buildLedger(
  phxRows: PhxSnapshot[],
  pnlRows: DailyPnlRow[],
  paysightByDate: Map<string, { subs: number; subOrders: number }>,
): LedgerRow[] {
  type Acc = {
    orders: number;
    revenue: number;
    new_rev: number;
    new_count: number;
    rebill_rev: number;
    ad_spend: number;
    cogs: number;
    fees: number;
  };
  const byDate = new Map<string, Acc>();
  const get = (d: string) => {
    let m = byDate.get(d);
    if (!m) {
      m = {
        orders: 0,
        revenue: 0,
        new_rev: 0,
        new_count: 0,
        rebill_rev: 0,
        ad_spend: 0,
        cogs: 0,
        fees: 0,
      };
      byDate.set(d, m);
    }
    return m;
  };
  // Phoenix per-day subs, split into NEW (Initial enrollments) and REBILL
  // (Recurring + Salvage re-charges of existing subscribers).
  const phxByDate = new Map<
    string,
    {
      revenue: number;
      newRev: number;
      newCount: number;
      rebillRev: number;
      orders: number;
    }
  >();
  for (const r of phxRows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const d = r.range_from;
    const newRev = num(r.revenue_initial);
    const rebillRev = num(r.revenue_recurring) + num(r.revenue_salvage);
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    const newCount = Number(j.initialCount ?? 0);
    const ord =
      newCount +
      Number(j.recurringCount ?? 0) +
      Number(j.salvageCount ?? 0);
    const cur =
      phxByDate.get(d) ??
      { revenue: 0, newRev: 0, newCount: 0, rebillRev: 0, orders: 0 };
    cur.revenue += newRev + rebillRev;
    cur.newRev += newRev;
    cur.newCount += newCount;
    cur.rebillRev += rebillRev;
    cur.orders += ord;
    phxByDate.set(d, cur);
  }
  // Subscription revenue per day = BILLED only: Phoenix billed (Initial +
  // Recurring + Salvage) + Paysight rebills (payment_number >= 1; the loader
  // filters). Additive — each rebill is charged on exactly one platform, so
  // no double-count. Newly-acquired cycle-0 checkout charges are store
  // revenue, not Subs Rev (client spec Jun 2026).
  const allDates = new Set<string>([
    ...phxByDate.keys(),
    ...paysightByDate.keys(),
  ]);
  for (const d of allDates) {
    const pay = paysightByDate.get(d);
    const phx = phxByDate.get(d);
    const m = get(d);
    m.revenue += (phx?.revenue ?? 0) + (pay?.subs ?? 0);
    // NEW = Phoenix Initial enrollments. REBILL = Phoenix Recurring + Salvage,
    // plus Paysight rebills (payment_number >= 1 — the loader already filters,
    // so pay.subs is rebill-only). Currently Paysight rebills are $0 (cycles
    // start ~mid-Jul), so today rebill comes entirely from Phoenix.
    m.new_rev += phx?.newRev ?? 0;
    m.new_count += phx?.newCount ?? 0;
    m.rebill_rev += (phx?.rebillRev ?? 0) + (pay?.subs ?? 0);
    m.orders += (phx?.orders ?? 0) + (pay?.subOrders ?? 0);
  }
  // COGS still comes from daily_pnl (subscription fulfillment cost). Ad spend
  // and Shopify processing fees are NOT a subscription concern — subscriptions
  // are billed by the CRM (Phoenix/Paysight) at a ~16% processing fee, applied
  // below. (This is what removes the misleading "$22k ad spend" the client
  // flagged: ad spend belongs to the Stores page, not here.)
  for (const r of pnlRows) {
    const m = get(r.date);
    m.cogs += num(r.cogs);
  }
  const out: LedgerRow[] = [];
  for (const [date, m] of [...byDate.entries()].sort((a, b) =>
    b[0].localeCompare(a[0]),
  )) {
    // Subscription processing fee ~16% of billed revenue (client spec).
    m.fees = m.revenue * SUBS_FEE_RATE;
    m.ad_spend = 0;
    const gross_profit = m.revenue - m.cogs;
    const net_profit = gross_profit - m.fees;
    const roas = 0;
    out.push({ date, ...m, gross_profit, net_profit, roas });
  }
  return out;
}

function sumLedger(rows: LedgerRow[]) {
  let orders = 0,
    revenue = 0,
    new_rev = 0,
    new_count = 0,
    rebill_rev = 0,
    ad_spend = 0,
    cogs = 0,
    fees = 0,
    gross_profit = 0,
    net_profit = 0;
  for (const r of rows) {
    orders += r.orders;
    revenue += r.revenue;
    new_rev += r.new_rev;
    new_count += r.new_count;
    rebill_rev += r.rebill_rev;
    ad_spend += r.ad_spend;
    cogs += r.cogs;
    fees += r.fees;
    gross_profit += r.gross_profit;
    net_profit += r.net_profit;
  }
  const roas = ad_spend > 0 ? revenue / ad_spend : 0;
  return {
    orders,
    revenue,
    new_rev,
    new_count,
    rebill_rev,
    ad_spend,
    cogs,
    fees,
    gross_profit,
    net_profit,
    roas,
  };
}

/** Aggregate per-type subscription counts across the window from the per-store
 *  PHX snapshots (raw_json carries initialCount/recurringCount/salvageCount/
 *  directCount/upsellCount). The PORTFOLIO snapshot no longer carries these,
 *  so we sum them from the window's daily rows instead. */
function aggregateOrderMix(phxRows: PhxSnapshot[]) {
  let direct = 0,
    initial = 0,
    recurring = 0,
    salvage = 0,
    upsell = 0;
  for (const r of phxRows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    direct += Number(j.directCount ?? 0);
    initial += Number(j.initialCount ?? 0);
    recurring += Number(j.recurringCount ?? 0);
    salvage += Number(j.salvageCount ?? 0);
    upsell += Number(j.upsellCount ?? 0);
  }
  return { direct, initial, recurring, salvage, upsell };
}

export default async function SubscriptionsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    store?: string;
  }>;
}) {
  const params = await searchParams;
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);
  const range = RANGES.find((r) => r.id === params.range) ?? RANGES[1];
  const selected = parseStoreList(params.store ?? "");
  const activeParam = selected.slice().sort().join(",");

  const to = hasCustom ? customTo! : todayUtc();
  const from = hasCustom ? customFrom! : addDays(to, -(range.days - 1));
  const rangeLabel = hasCustom
    ? `${fmtDate(from)} → ${fmtDate(to)}`
    : `Last ${range.days} days`;

  const tenant = await requireTenant();
  const stores = await loadStores(tenant.id);
  const phxStores = stores.map((s) => s.id).filter((id) => PHX_STORE_IDS.has(id));
  const selectedPhx =
    selected.length === 0 ? phxStores : phxStores.filter((id) => selected.includes(id));

  const [snapshot, phxDays, pnlRows, paysightSubsByDate, blended, churn] =
    await Promise.all([
      loadLatestPortfolioSnapshot(tenant.id),
      loadPhxDailyRows(from, to, selectedPhx, tenant.id),
      loadDailyPnl(from, to, selectedPhx, tenant.id),
      loadPaysightSubsByDate(tenant.id, from, to, selectedPhx),
      // Full blended P&L (same as main dashboard) but scoped to the
      // subscription stores only — client wants ad spend / ROAS / totals here.
      loadBlendedDashboardData(
        tenant.id,
        { from, to },
        { storeScope: "subscription", storeIds: selectedPhx },
      ),
      // Cohort-based monthly churn (headline only — full view on /churn).
      computeCohortChurn(tenant.id, { maxCycle: 6 }),
    ]);

  const ledger = buildLedger(phxDays, pnlRows, paysightSubsByDate);
  const totals = sumLedger(ledger);

  // chips
  const chipHrefAll = `/subscriptions${qs({
    range: hasCustom ? "" : range.id,
    from: hasCustom ? customFrom! : "",
    to: hasCustom ? customTo! : "",
  })}`;
  const buildToggleHref = (storeId: string): string => {
    const next = new Set(selected);
    if (next.has(storeId)) next.delete(storeId);
    else next.add(storeId);
    const param = Array.from(next).sort().join(",");
    return `/subscriptions${qs({
      range: hasCustom ? "" : range.id,
      from: hasCustom ? customFrom! : "",
      to: hasCustom ? customTo! : "",
      store: param,
    })}`;
  };

  return (
    <>
      <div className="pnl-header">
        <div>
          <h2 className="section-title">Subscriptions</h2>
          <div className="section-sub">
            PHX subscription operations · Initial + Recurring + Salvage. ·{" "}
            {rangeLabel}
            {selected.length > 0 ? ` · ${selected.join(", ")}` : ""}
          </div>
        </div>
        <div className="pnl-controls">
          <SyncDataButton
            sources={["paysight", "phoenix"]}
            description="Re-pull billed subscription revenue from Paysight & Phoenix into the database."
          />
        </div>
      </div>

      {/* ── Lifetime KPI strip (from latest snapshot) ── */}
      {snapshot ? (
        <KpiStrip
          snapshot={snapshot}
          totals={totals}
          churnPct={churn.monthlyChurnPct}
        />
      ) : (
        <NoSnapshotBanner />
      )}

      {/* ── Filter rail — sits directly above the ledger (search + stores
            on the left · range + date + Apply on the right). ── */}
      <div className="subs-filterbar" role="group" aria-label="Filters">
        <SubsSearchInput />
        <div
          role="group"
          aria-label="Stores"
          style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
        >
          <Link
            href={chipHrefAll}
            className={`store-chip ${selected.length === 0 ? "active" : ""}`}
            prefetch={false}
          >
            All
          </Link>
          {phxStores.map((id) => (
            <Link
              key={id}
              href={buildToggleHref(id)}
              className={`store-chip ${selected.includes(id) ? "active" : ""}`}
              prefetch={false}
            >
              {id}
            </Link>
          ))}
        </div>
        <div className="subs-filterbar-right">
          <div className="seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/subscriptions${qs({
                  range: r.id,
                  store: activeParam,
                })}`}
              >
                {r.id}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/subscriptions${qs({
                store: activeParam,
                from: customFrom ?? from,
                to: customTo ?? to,
              })}`}
            >
              Custom
            </SegLink>
          </div>
          <SubsDateRange
            action="/subscriptions"
            from={customFrom ?? from}
            to={customTo ?? to}
            hidden={{ store: activeParam }}
          />
        </div>
      </div>

      {/* ── Daily ledger — same blended table as the main dashboard, but
            scoped to the subscription stores only, with a 16.3% subscription
            processor Fees column (client spec Jun 2026). ── */}
      <BlendedPnlTable
        rows={blended.daily}
        showFees
        feeRate={0.163}
        csvFilename="daily-pnl-blended"
        footerLabel={rangeLabel}
        searchable
      />

      {/* ── Order mix ── */}
      <OrderMix mix={aggregateOrderMix(phxDays)} />
    </>
  );
}

function KpiStrip({
  snapshot,
  totals,
  churnPct,
}: {
  snapshot: PhxSnapshot;
  totals: ReturnType<typeof sumLedger>;
  churnPct: number | null;
}) {
  // Subscription financials for the selected window (billed revenue only).
  const grossRevenue = totals.revenue;
  const netMargin =
    grossRevenue > 0 ? (totals.net_profit / grossRevenue) * 100 : 0;
  // Average gross per billed order in the window.
  const avgGross = totals.orders > 0 ? grossRevenue / totals.orders : 0;
  return (
    <section className="kpi-row kpi-6">
      <KpiCard
        label="Monthly Churn"
        value={churnPct == null ? "—" : `${churnPct.toFixed(1)}%`}
        delta={null}
        deltaLabel="M1→M2 · cohort-based"
        spark={[]}
        sparkColor="var(--danger, #ef4444)"
        icon={<TrendingDown size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Active Subscribers"
        value={fmtInt(snapshot.active_subscribers)}
        delta={null}
        deltaLabel="lifetime · as of latest scrape"
        spark={[]}
        icon={<Users size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Billed Subscriptions"
        value={fmtInt(totals.orders)}
        delta={null}
        deltaLabel="subscription charges · window"
        spark={[]}
        icon={<CreditCard size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Gross Revenue"
        value={fmtMoney(grossRevenue)}
        delta={null}
        deltaLabel="billed subscriptions · window"
        spark={[]}
        icon={<CreditCard size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Net Margin"
        value={`${netMargin.toFixed(1)}%`}
        delta={null}
        deltaLabel="after ~16% fees · window"
        spark={[]}
        sparkColor="var(--positive)"
        icon={<Target size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Average Gross"
        value={fmtMoney(avgGross)}
        delta={null}
        deltaLabel="per billed subscription · window"
        spark={[]}
        icon={<Activity size={14} strokeWidth={1.75} />}
      />
    </section>
  );
}

function NoSnapshotBanner() {
  return (
    <div
      className="card"
      style={{
        padding: "20px",
        textAlign: "center",
        color: "var(--muted)",
        fontSize: 12,
      }}
    >
      No PHX snapshot has landed yet. Check the Solvpath sync.
    </div>
  );
}

function OrderMix({
  mix,
}: {
  mix: ReturnType<typeof aggregateOrderMix>;
}) {
  const rows = [
    { label: "Direct Sale", count: mix.direct },
    { label: "Initial Subscription", count: mix.initial },
    { label: "Recurring Subscription", count: mix.recurring },
  ];
  const total = rows.reduce((s, r) => s + (r.count ?? 0), 0);

  return (
    <div className="card table-card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Order mix</div>
          <div className="card-sub">
            Billed subscription counts by type · window
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Count</th>
              <th className="num">% of mix</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const share = total > 0 ? ((r.count ?? 0) / total) * 100 : 0;
              return (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{fmtInt(r.count)}</td>
                  <td className="num muted">
                    {share > 0 ? fmtPct(share) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="tfoot-row">
              <td>Total</td>
              <td className="num">{fmtInt(total)}</td>
              <td className="num">100.0%</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <TableFooter
        count={rows.length}
        label="Billed subscription counts · window"
        csv={{
          headers: ["Type", "Count", "% of mix"],
          rows: rows.map((r) => [
            r.label,
            fmtInt(r.count),
            total > 0 ? fmtPct(((r.count ?? 0) / total) * 100) : "—",
          ]),
          filename: "order-mix",
        }}
      />
    </div>
  );
}

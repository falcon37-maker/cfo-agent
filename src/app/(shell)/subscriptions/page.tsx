// /subscriptions — Overview tab.
// Daily ledger (Initial + Recurring + Salvage from PHX) + lifetime KPI strip
// + transaction-type Order Mix.

import Link from "next/link";
import {
  Users,
  CreditCard,
  Target,
  Activity,
  AlertCircle,
} from "lucide-react";
import {
  loadLatestPortfolioSnapshot,
  loadPhxDailyRows,
  type PhxSnapshot,
} from "@/lib/phx/queries";
import { loadStores } from "@/lib/pnl/queries";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fmtDate, fmtInt, fmtMoney, fmtPct } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscriptions — CFO Agent" };

const PHX_STORE_IDS = new Set(["NOVA", "NURA", "KOVA"]);
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
): LedgerRow[] {
  type Acc = {
    orders: number;
    revenue: number;
    ad_spend: number;
    cogs: number;
    fees: number;
  };
  const byDate = new Map<string, Acc>();
  const get = (d: string) => {
    let m = byDate.get(d);
    if (!m) {
      m = { orders: 0, revenue: 0, ad_spend: 0, cogs: 0, fees: 0 };
      byDate.set(d, m);
    }
    return m;
  };
  for (const r of phxRows) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const d = r.range_from;
    const m = get(d);
    m.revenue +=
      num(r.revenue_initial) +
      num(r.revenue_recurring) +
      num(r.revenue_salvage);
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    m.orders +=
      Number(j.initialCount ?? 0) +
      Number(j.recurringCount ?? 0) +
      Number(j.salvageCount ?? 0);
  }
  for (const r of pnlRows) {
    const m = get(r.date);
    m.ad_spend += num(r.ad_spend);
    m.cogs += num(r.cogs);
    m.fees += num(r.fees);
  }
  const out: LedgerRow[] = [];
  for (const [date, m] of [...byDate.entries()].sort((a, b) =>
    b[0].localeCompare(a[0]),
  )) {
    const gross_profit = m.revenue - m.cogs - m.fees;
    const net_profit = gross_profit - m.ad_spend;
    const roas = m.ad_spend > 0 ? m.revenue / m.ad_spend : 0;
    out.push({ date, ...m, gross_profit, net_profit, roas });
  }
  return out;
}

function sumLedger(rows: LedgerRow[]) {
  let orders = 0,
    revenue = 0,
    ad_spend = 0,
    cogs = 0,
    fees = 0,
    gross_profit = 0,
    net_profit = 0;
  for (const r of rows) {
    orders += r.orders;
    revenue += r.revenue;
    ad_spend += r.ad_spend;
    cogs += r.cogs;
    fees += r.fees;
    gross_profit += r.gross_profit;
    net_profit += r.net_profit;
  }
  const roas = ad_spend > 0 ? revenue / ad_spend : 0;
  return { orders, revenue, ad_spend, cogs, fees, gross_profit, net_profit, roas };
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

  const [snapshot, phxDays, pnlRows] = await Promise.all([
    loadLatestPortfolioSnapshot(tenant.id),
    loadPhxDailyRows(from, to, selectedPhx, tenant.id),
    loadDailyPnl(from, to, selectedPhx, tenant.id),
  ]);

  const ledger = buildLedger(phxDays, pnlRows);
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
          <DateRangeForm
            action="/subscriptions"
            from={customFrom ?? from}
            to={customTo ?? to}
            hidden={{ store: activeParam }}
          />
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
        </div>
      </div>

      {/* ── Lifetime KPI strip (from latest snapshot) ── */}
      {snapshot ? <KpiStrip snapshot={snapshot} /> : <NoSnapshotBanner />}

      {/* ── Daily ledger ── */}
      <div className="card table-card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Daily ledger · subscriptions</div>
            <div className="card-sub">
              Per-day Initial + Recurring + Salvage revenue, plus the
              Shopify-side ad spend / COGS / fees for the same stores.
            </div>
          </div>
        </div>
        <div className="table-wrap" style={{ maxHeight: 560 }}>
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Orders</th>
                <th className="num">Revenue</th>
                <th className="num">Ad Spend</th>
                <th className="num">COGS</th>
                <th className="num">Fees</th>
                <th className="num">Gross Profit</th>
                <th className="num">Net Profit</th>
                <th className="num">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r) => (
                <tr key={r.date}>
                  <td>{fmtDate(r.date)}</td>
                  <td className="num muted">{fmtInt(r.orders)}</td>
                  <td className="num">{fmtMoney(r.revenue)}</td>
                  <td className="num muted">{fmtMoney(r.ad_spend)}</td>
                  <td className="num muted">{fmtMoney(r.cogs)}</td>
                  <td className="num muted">{fmtMoney(r.fees)}</td>
                  <td className="num">{fmtMoney(r.gross_profit)}</td>
                  <td
                    className={`num profit ${r.net_profit >= 0 ? "pos" : "neg"}`}
                  >
                    <span className="profit-pill">{fmtMoney(r.net_profit)}</span>
                  </td>
                  <td
                    className={`num roas ${r.ad_spend > 0 ? (r.roas >= 2 ? "pos" : "neg") : ""}`}
                  >
                    {r.ad_spend > 0 ? `${r.roas.toFixed(2)}x` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            {ledger.length > 0 ? (
              <tfoot>
                <tr className="tfoot-row">
                  <td>Total</td>
                  <td className="num">{fmtInt(totals.orders)}</td>
                  <td className="num">{fmtMoney(totals.revenue)}</td>
                  <td className="num">{fmtMoney(totals.ad_spend)}</td>
                  <td className="num">{fmtMoney(totals.cogs)}</td>
                  <td className="num">{fmtMoney(totals.fees)}</td>
                  <td className="num">{fmtMoney(totals.gross_profit)}</td>
                  <td className={`num profit ${totals.net_profit >= 0 ? "pos" : "neg"}`}>
                    <span className="profit-pill">{fmtMoney(totals.net_profit)}</span>
                  </td>
                  <td
                    className={`num roas ${totals.ad_spend > 0 ? (totals.roas >= 2 ? "pos" : "neg") : ""}`}
                  >
                    {totals.ad_spend > 0 ? `${totals.roas.toFixed(2)}x` : "—"}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
          {ledger.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
              No subscription data in this range. Check that Solvpath has
              synced — the latest scrape was{" "}
              {snapshot?.scraped_at?.slice(0, 10) ?? "(never)"}.
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Order mix ── */}
      {snapshot ? <OrderMix snapshot={snapshot} /> : null}
    </>
  );
}

function KpiStrip({ snapshot }: { snapshot: PhxSnapshot }) {
  return (
    <section className="kpi-row kpi-5">
      <KpiCard
        label="Active Subscribers"
        value={fmtInt(snapshot.active_subscribers)}
        delta={null}
        deltaLabel="lifetime · as of latest scrape"
        spark={[]}
        icon={<Users size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Subs to bill"
        value={fmtInt(snapshot.subscriptions_to_bill)}
        delta={null}
        deltaLabel="next billing window"
        spark={[]}
        icon={<CreditCard size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Target CAC"
        value={
          snapshot.target_cac != null ? fmtMoney(snapshot.target_cac) : "—"
        }
        delta={null}
        deltaLabel="from latest snapshot"
        spark={[]}
        sparkColor="var(--muted-strong)"
        invert
        icon={<Target size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Transactions"
        value={fmtInt(snapshot.total_transactions_mtd)}
        delta={null}
        deltaLabel="MTD · latest snapshot"
        spark={[]}
        icon={<Activity size={14} strokeWidth={1.75} />}
      />
      <KpiCard
        label="Refund total"
        value={fmtMoney(snapshot.refund_total)}
        delta={null}
        deltaLabel="MTD · latest snapshot"
        spark={[]}
        sparkColor="var(--negative)"
        invert
        icon={<AlertCircle size={14} strokeWidth={1.75} />}
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

function OrderMix({ snapshot }: { snapshot: PhxSnapshot }) {
  const rows = [
    {
      label: "Direct Sale",
      count: snapshot.direct_sale_count,
      pct: snapshot.direct_sale_success_pct,
    },
    {
      label: "Initial Subscription",
      count: snapshot.initial_subscription_count,
      pct: snapshot.initial_subscription_success_pct,
    },
    {
      label: "Recurring Subscription",
      count: snapshot.recurring_subscription_count,
      pct: snapshot.recurring_subscription_success_pct,
    },
    {
      label: "Subscription Salvage",
      count: snapshot.subscription_salvage_count,
      pct: snapshot.subscription_salvage_success_pct,
    },
    {
      label: "Upsell",
      count: snapshot.upsell_count,
      pct: snapshot.upsell_success_pct,
    },
  ];
  const total = rows.reduce((s, r) => s + (r.count ?? 0), 0);

  return (
    <div className="card table-card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Order mix</div>
          <div className="card-sub">
            Counts and approval rates from latest PHX snapshot
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
              <th className="num">Approval %</th>
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
                  <td className="num muted">
                    {r.pct != null ? fmtPct(r.pct) : "—"}
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
              <td className="num">—</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

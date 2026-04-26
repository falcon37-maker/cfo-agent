// /subscriptions/data-center — deep-dive metrics for subscription operations.

import Link from "next/link";
import {
  loadLatestPortfolioSnapshot,
  loadPhxDailyRows,
} from "@/lib/phx/queries";
import { loadStores } from "@/lib/pnl/queries";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import {
  DollarSign,
  Scissors,
  Landmark,
  Percent,
  Receipt,
  Users,
  TrendingDown,
  Activity,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscriptions · Data Center — CFO Agent" };

const PHX_STORE_IDS = new Set(["NOVA", "NURA", "KOVA"]);
const PHX_FEE_RATE_FALLBACK = 0.1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGES: Array<{ id: string; days: number }> = [
  { id: "7d", days: 7 },
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
];

// helpers
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd: string, d: number): string => {
  const [y, m, dd] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
};
const qs = (p: Record<string, string>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
};
const parseStoreList = (raw: string): string[] => {
  if (!raw || raw.toLowerCase() === "all") return [];
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
};
const num = (v: number | string | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

type DailyPnlRow = {
  store_id: string;
  date: string;
  fees: number | string | null;
  refunds: number | string | null;
};

async function loadDailyPnlFees(
  from: string,
  to: string,
  storeIds: string[],
): Promise<DailyPnlRow[]> {
  const sb = supabaseAdmin();
  let q = sb
    .from("daily_pnl")
    .select("store_id, date, fees, refunds")
    .gte("date", from)
    .lte("date", to);
  if (storeIds.length > 0) q = q.in("store_id", storeIds);
  const { data } = await q;
  return (data ?? []) as DailyPnlRow[];
}

async function loadAlertsInWindow(
  from: string,
  to: string,
): Promise<number> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("chargeblast_alerts")
    .select("amount")
    .gte("chargeblast_created_at", `${from}T00:00:00Z`)
    .lte("chargeblast_created_at", `${to}T23:59:59Z`);
  return (data ?? []).reduce(
    (s, r: { amount: number | null }) => s + Number(r.amount ?? 0),
    0,
  );
}

export default async function SubscriptionsDataCenterPage({
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

  const to = hasCustom ? customTo! : today();
  const from = hasCustom ? customFrom! : addDays(to, -(range.days - 1));
  const rangeLabel = hasCustom
    ? `${fmtDate(from)} → ${fmtDate(to)}`
    : `Last ${range.days} days`;

  const stores = await loadStores();
  const phxStores = stores.map((s) => s.id).filter((id) => PHX_STORE_IDS.has(id));
  const selectedPhx =
    selected.length === 0 ? phxStores : phxStores.filter((id) => selected.includes(id));

  const feeRate =
    Number(stores.find((s) => s.id !== "PORTFOLIO")?.processing_fee_pct ?? PHX_FEE_RATE_FALLBACK) ||
    PHX_FEE_RATE_FALLBACK;

  const [snapshot, phxDays, pnlRows, alertCost] = await Promise.all([
    loadLatestPortfolioSnapshot(),
    loadPhxDailyRows(from, to, selectedPhx),
    loadDailyPnlFees(from, to, selectedPhx),
    loadAlertsInWindow(from, to),
  ]);

  // ── per-store + per-type aggregation ─────────────────────────────────────
  type Bucket = {
    direct: number;
    initial: number;
    recurring: number;
    salvage: number;
    upsell: number;
    directCount: number;
    initialCount: number;
    recurringCount: number;
    salvageCount: number;
    upsellCount: number;
  };
  const empty = (): Bucket => ({
    direct: 0,
    initial: 0,
    recurring: 0,
    salvage: 0,
    upsell: 0,
    directCount: 0,
    initialCount: 0,
    recurringCount: 0,
    salvageCount: 0,
    upsellCount: 0,
  });
  const portfolio = empty();
  const byStore = new Map<string, Bucket>();
  for (const r of phxDays) {
    if (!r.range_from || r.range_from !== r.range_to) continue;
    const sid = r.store_id;
    if (!byStore.has(sid)) byStore.set(sid, empty());
    const s = byStore.get(sid)!;
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    const directCount = Number(j.directCount ?? 0);
    const initialCount = Number(j.initialCount ?? 0);
    const recurringCount = Number(j.recurringCount ?? 0);
    const salvageCount = Number(j.salvageCount ?? 0);
    const upsellCount = Number(j.upsellCount ?? 0);

    const direct = num(r.revenue_direct);
    const initial = num(r.revenue_initial);
    const recurring = num(r.revenue_recurring);
    const salvage = num(r.revenue_salvage);
    const upsell = num(r.revenue_upsell);
    s.direct += direct;
    s.initial += initial;
    s.recurring += recurring;
    s.salvage += salvage;
    s.upsell += upsell;
    s.directCount += directCount;
    s.initialCount += initialCount;
    s.recurringCount += recurringCount;
    s.salvageCount += salvageCount;
    s.upsellCount += upsellCount;
    portfolio.direct += direct;
    portfolio.initial += initial;
    portfolio.recurring += recurring;
    portfolio.salvage += salvage;
    portfolio.upsell += upsell;
    portfolio.directCount += directCount;
    portfolio.initialCount += initialCount;
    portfolio.recurringCount += recurringCount;
    portfolio.salvageCount += salvageCount;
    portfolio.upsellCount += upsellCount;
  }

  // Subscription-only revenue = Initial + Recurring + Salvage.
  const subRevenue =
    portfolio.initial + portfolio.recurring + portfolio.salvage;
  const subTxCount =
    portfolio.initialCount + portfolio.recurringCount + portfolio.salvageCount;
  const grossRevenue = subRevenue + portfolio.direct + portfolio.upsell;

  let processingFees = 0;
  let refunds = 0;
  for (const r of pnlRows) {
    processingFees += num(r.fees);
    refunds += num(r.refunds);
  }
  const gatewayFees = grossRevenue * feeRate;
  const totalFees = processingFees + gatewayFees + alertCost + refunds;
  const netRevenue = grossRevenue - totalFees;
  const feePct = grossRevenue > 0 ? (totalFees / grossRevenue) * 100 : 0;
  const effectiveProcessingRate =
    grossRevenue > 0
      ? ((processingFees + gatewayFees) / grossRevenue) * 100
      : 0;
  const avgTxValue = subTxCount > 0 ? subRevenue / subTxCount : 0;

  const activeSubs = snapshot?.active_subscribers ?? 0;
  const cancelledSubs = snapshot?.cancelled_subscribers ?? 0;
  const revenuePerSubscriber =
    activeSubs > 0 ? subRevenue / activeSubs : 0;
  const churnRate =
    activeSubs + cancelledSubs > 0
      ? (cancelledSubs / (activeSubs + cancelledSubs)) * 100
      : 0;

  const feeRows = [
    {
      label: "Processing Fees (Shopify-side)",
      amount: processingFees,
      note: "From daily_pnl.fees",
    },
    {
      label: "Gateway Fees (PHX)",
      amount: gatewayFees,
      note: `Estimated · ${(feeRate * 100).toFixed(1)}% of gross`,
    },
    {
      label: "Chargeblast Alert Costs",
      amount: alertCost,
      note: "From chargeblast_alerts.amount",
    },
    {
      label: "Refunds",
      amount: refunds,
      note: "From daily_pnl.refunds",
    },
  ];

  const perStoreRows = [...byStore.entries()]
    .map(([id, b]) => {
      const sub = b.initial + b.recurring + b.salvage;
      const subCnt = b.initialCount + b.recurringCount + b.salvageCount;
      const total = b.direct + b.initial + b.recurring + b.salvage + b.upsell;
      const aov = subCnt > 0 ? sub / subCnt : 0;
      return { id, sub, subCnt, total, aov, recurring: b.recurring, salvage: b.salvage, initial: b.initial };
    })
    .sort((a, b) => b.sub - a.sub);

  const txTypeRows = [
    {
      label: "Direct Sale",
      count: portfolio.directCount,
      revenue: portfolio.direct,
    },
    {
      label: "Initial Subscription",
      count: portfolio.initialCount,
      revenue: portfolio.initial,
    },
    {
      label: "Recurring",
      count: portfolio.recurringCount,
      revenue: portfolio.recurring,
    },
    {
      label: "Salvage",
      count: portfolio.salvageCount,
      revenue: portfolio.salvage,
    },
    {
      label: "Upsell",
      count: portfolio.upsellCount,
      revenue: portfolio.upsell,
    },
  ];

  // Approval % comes from the latest snapshot only — per-day approval data
  // isn't in raw_json. So we expose it from the snapshot for now.
  const approvalPct: Record<string, number | null> = snapshot
    ? {
        "Direct Sale": snapshot.direct_sale_success_pct,
        "Initial Subscription": snapshot.initial_subscription_success_pct,
        "Recurring": snapshot.recurring_subscription_success_pct,
        "Salvage": snapshot.subscription_salvage_success_pct,
        "Upsell": snapshot.upsell_success_pct,
      }
    : {};

  // chips
  const chipHrefAll = `/subscriptions/data-center${qs({
    range: hasCustom ? "" : range.id,
    from: hasCustom ? customFrom! : "",
    to: hasCustom ? customTo! : "",
  })}`;
  const buildToggleHref = (storeId: string): string => {
    const next = new Set(selected);
    if (next.has(storeId)) next.delete(storeId);
    else next.add(storeId);
    const param = Array.from(next).sort().join(",");
    return `/subscriptions/data-center${qs({
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
          <h2 className="section-title">Subscriptions · Data Center</h2>
          <div className="section-sub">
            Comprehensive financial metrics for subscription operations · {rangeLabel}
            {selected.length > 0 ? ` · ${selected.join(", ")}` : ""}
          </div>
        </div>
        <div className="pnl-controls">
          <div className="seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/subscriptions/data-center${qs({
                  range: r.id,
                  store: activeParam,
                })}`}
              >
                {r.id}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/subscriptions/data-center${qs({
                store: activeParam,
                from: customFrom ?? from,
                to: customTo ?? to,
              })}`}
            >
              Custom
            </SegLink>
          </div>
          <DateRangeForm
            action="/subscriptions/data-center"
            from={customFrom ?? from}
            to={customTo ?? to}
            hidden={{ store: activeParam }}
          />
          <div role="group" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
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

      {/* ── Top KPI grid ── */}
      <section style={{ marginTop: 16 }}>
        <div className="kpi-row kpi-5">
          <KpiCard
            label="Total Gross Revenue"
            value={fmtMoney(grossRevenue)}
            delta={null}
            deltaLabel="all PHX revenue"
            spark={[]}
            icon={<DollarSign size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Total Fees"
            value={fmtMoney(totalFees)}
            delta={null}
            deltaLabel="processing + gateway + alerts + refunds"
            spark={[]}
            sparkColor="var(--negative)"
            invert
            icon={<Scissors size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Net Revenue"
            value={fmtMoney(netRevenue)}
            delta={null}
            deltaLabel="gross − all fees"
            spark={[]}
            sparkColor={netRevenue >= 0 ? "var(--accent)" : "var(--negative)"}
            icon={<Landmark size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Fee %"
            value={`${feePct.toFixed(2)}%`}
            delta={null}
            deltaLabel="all fees / gross"
            spark={[]}
            icon={<Percent size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Effective Processing Rate"
            value={`${effectiveProcessingRate.toFixed(2)}%`}
            delta={null}
            deltaLabel="processing + gateway only"
            spark={[]}
            icon={<Receipt size={14} strokeWidth={1.75} />}
          />
        </div>
      </section>

      <section style={{ marginTop: 12 }}>
        <div className="kpi-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <KpiCard
            label="Avg Transaction Value"
            value={fmtMoney(avgTxValue)}
            delta={null}
            deltaLabel="initial + recurring + salvage"
            spark={[]}
            icon={<Activity size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Revenue Per Subscriber"
            value={fmtMoney(revenuePerSubscriber)}
            delta={null}
            deltaLabel={`active subs ${fmtInt(activeSubs)}`}
            spark={[]}
            icon={<Users size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Churn Rate"
            value={`${churnRate.toFixed(1)}%`}
            delta={null}
            deltaLabel="cancelled / (active + cancelled)"
            spark={[]}
            sparkColor="var(--negative)"
            invert
            icon={<TrendingDown size={14} strokeWidth={1.75} />}
          />
        </div>
      </section>

      {/* ── Fee Breakdown ── */}
      <section style={{ marginTop: 16 }}>
        <div className="section-eyebrow">Fee breakdown</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Fee Type</th>
                  <th className="num">Amount</th>
                  <th className="num">% of Revenue</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {feeRows.map((r) => {
                  const pct = grossRevenue > 0 ? (r.amount / grossRevenue) * 100 : 0;
                  return (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="num">{fmtMoney(r.amount)}</td>
                      <td className="num muted">{pct.toFixed(2)}%</td>
                      <td className="muted" style={{ fontSize: 11 }}>{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="tfoot-row">
                  <td>Total Deductions</td>
                  <td className="num">{fmtMoney(totalFees)}</td>
                  <td className="num">{feePct.toFixed(2)}%</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      {/* ── Per-Store Breakdown ── */}
      <section style={{ marginTop: 16 }}>
        <div className="section-eyebrow">Per-store breakdown</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Store</th>
                  <th className="num">Sub Revenue</th>
                  <th className="num">Initial</th>
                  <th className="num">Recurring</th>
                  <th className="num">Salvage</th>
                  <th className="num">Sub Tx</th>
                  <th className="num">Avg Tx</th>
                </tr>
              </thead>
              <tbody>
                {perStoreRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td className="num">{fmtMoney(r.sub)}</td>
                    <td className="num muted">{fmtMoney(r.initial)}</td>
                    <td className="num muted">{fmtMoney(r.recurring)}</td>
                    <td className="num muted">{fmtMoney(r.salvage)}</td>
                    <td className="num muted">{fmtInt(r.subCnt)}</td>
                    <td className="num muted">{r.aov > 0 ? fmtMoney(r.aov) : "—"}</td>
                  </tr>
                ))}
                {perStoreRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--muted)" }}>
                      No PHX data in this range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr className="tfoot-row">
                  <td>Total</td>
                  <td className="num">{fmtMoney(subRevenue)}</td>
                  <td className="num">{fmtMoney(portfolio.initial)}</td>
                  <td className="num">{fmtMoney(portfolio.recurring)}</td>
                  <td className="num">{fmtMoney(portfolio.salvage)}</td>
                  <td className="num">{fmtInt(subTxCount)}</td>
                  <td className="num">{avgTxValue > 0 ? fmtMoney(avgTxValue) : "—"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      {/* ── Transaction Type Breakdown ── */}
      <section style={{ marginTop: 16 }}>
        <div className="section-eyebrow">Transaction-type breakdown</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="num">Count</th>
                  <th className="num">Revenue</th>
                  <th className="num">Avg Amount</th>
                  <th className="num">Approval %</th>
                </tr>
              </thead>
              <tbody>
                {txTypeRows.map((r) => {
                  const avg = r.count > 0 ? r.revenue / r.count : 0;
                  const ap = approvalPct[r.label];
                  return (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="num">{fmtInt(r.count)}</td>
                      <td className="num">{r.revenue > 0 ? fmtMoney(r.revenue) : "—"}</td>
                      <td className="num muted">{avg > 0 ? fmtMoney(avg) : "—"}</td>
                      <td className="num muted">
                        {ap != null ? `${ap.toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="section-sub" style={{ padding: "8px 16px", fontSize: 11 }}>
            Approval % comes from the latest PHX snapshot, not per-day data.
          </div>
        </div>
      </section>

      {/* ── Retention Metrics (placeholder) ── */}
      <section style={{ marginTop: 16 }}>
        <div className="section-eyebrow">Retention metrics</div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            <RetentionTile
              label="Day 20 Retention"
              value="—"
              note="Requires per-customer cohort data (Wave B)"
            />
            <RetentionTile
              label="Ongoing Rebill Retention"
              value="—"
              note="Requires per-customer rebill timeline"
            />
            <RetentionTile
              label="Average LTV"
              value="—"
              note="Requires customer lifetime aggregation"
            />
            <RetentionTile
              label="Months to Recover CAC"
              value={
                snapshot?.target_cac && avgTxValue > 0
                  ? (snapshot.target_cac / avgTxValue).toFixed(1)
                  : "—"
              }
              note="Target CAC / avg subscription tx"
            />
            <RetentionTile
              label="Stick Rate (lifetime)"
              value={
                activeSubs + cancelledSubs > 0
                  ? `${((activeSubs / (activeSubs + cancelledSubs)) * 100).toFixed(1)}%`
                  : "—"
              }
              note="Active / (active + cancelled)"
            />
            <RetentionTile
              label="Stick rate by cohort"
              value="—"
              note="Requires per-customer cohort data (Wave B)"
            />
          </div>
        </div>
      </section>
    </>
  );
}

function RetentionTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--muted)",
          fontWeight: 500,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: value === "—" ? "var(--muted-strong)" : "var(--text)",
          marginBottom: 4,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{note}</div>
    </div>
  );
}

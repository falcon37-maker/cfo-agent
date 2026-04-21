import { loadBlendedDashboardData } from "@/lib/pnl/queries";
import { loadLatestPortfolioSnapshot } from "@/lib/phx/queries";
import { fmtDate, fmtMoney } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { SourceMixDonut } from "@/components/dashboard/SourceMixDonut";
import { PnlTableWithRange } from "@/components/dashboard/PnlTableWithRange";
import { BreakdownToggle } from "@/components/dashboard/BreakdownToggle";
import { MiniBarChart } from "@/components/dashboard/MiniBarChart";
import { Greeting } from "@/components/dashboard/Greeting";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import {
  DollarSign,
  Megaphone,
  TrendingUp,
  Crosshair,
  Users,
  ArrowUpRight,
  LineChart,
  RefreshCcw,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Dashboard — CFO Agent",
};

const RANGES: Array<{ id: string; label: string; days: number }> = [
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// TODO: once Solvpath API is live, replace with actual scheduled billing amounts
// for current month (accounting for mid-month joins and pre-billing churn).
const AVG_SUB_PRICE = 39.95;

function qs(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Single-tenant app; no profile table yet.
const DISPLAY_NAME = "Joseph";

export default async function TotalPnlDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);
  const range = RANGES.find((r) => r.id === params.range) ?? RANGES[1];

  const [data, tablePool, phx] = await Promise.all([
    loadBlendedDashboardData(
      hasCustom ? { from: customFrom!, to: customTo! } : { days: range.days },
    ),
    // Table has its own range control — always load 90 days as the pool
    // and let the client filter.
    loadBlendedDashboardData({ days: 90 }),
    loadLatestPortfolioSnapshot(
      hasCustom ? { from: customFrom!, to: customTo! } : undefined,
    ),
  ]);

  const t = data.periodTotals;
  const p = data.priorPeriodTotals;

  const pct = (
    curr: number,
    prev: number | null | undefined,
  ): number | null => {
    if (prev == null || prev === 0) return curr === 0 ? 0 : null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const revDelta = pct(t.total_revenue, p?.total_revenue);
  const spendDelta = pct(t.shopify_ad_spend, p?.shopify_ad_spend);
  const roasDelta = pct(t.roas, p?.roas);
  const profitDelta = pct(t.total_net_profit, p?.total_net_profit);

  // Subscription metrics (from latest PORTFOLIO PHX snapshot)
  const activeSubs = phx?.active_subscribers ?? null;
  const cancelledTotal = phx?.cancelled_subscribers ?? null;
  const newSubs = phx?.new_subscribers ?? null;
  const cancelledPeriod = phx?.cancelled_subscribers_period ?? null;
  const netNew =
    newSubs != null && cancelledPeriod != null
      ? newSubs - cancelledPeriod
      : null;
  const mrr = activeSubs != null ? activeSubs * AVG_SUB_PRICE : null;
  const stickRate =
    activeSubs != null && cancelledTotal != null && activeSubs + cancelledTotal > 0
      ? (activeSubs / (activeSubs + cancelledTotal)) * 100
      : null;

  const rangeLabel = hasCustom
    ? `${fmtDate(customFrom!)} → ${fmtDate(customTo!)}`
    : `Last ${range.days} days`;

  const deltaLabel = p ? "vs prior period" : "no prior period";

  return (
    <div className="dashboard-narrow">
      <div className="pnl-header" style={{ alignItems: "center" }}>
        <Greeting name={DISPLAY_NAME} />
        <div className="pnl-controls">
          <div className="seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/${qs({ range: r.id })}`}
              >
                {r.label}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/${qs({
                from: customFrom ?? data.range.from,
                to: customTo ?? data.range.to,
              })}`}
            >
              Custom
            </SegLink>
          </div>
          <DateRangeForm
            action="/"
            from={customFrom ?? data.range.from}
            to={customTo ?? data.range.to}
          />
        </div>
      </div>

      {/* ─── MONEY STORY ─── */}
      <section>
        <div className="section-eyebrow">
          Money story · <span className="muted">{rangeLabel}</span>
        </div>
        <div className="kpi-row">
          <KpiCard
            label="Total Revenue"
            value={fmtMoney(t.total_revenue)}
            delta={revDelta}
            deltaLabel={deltaLabel}
            spark={data.kpiSparks.revenue}
            icon={<DollarSign size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Ad Spend"
            value={fmtMoney(t.shopify_ad_spend)}
            delta={spendDelta}
            deltaLabel={deltaLabel}
            invert
            spark={data.kpiSparks.ad_spend}
            sparkColor="var(--muted-strong)"
            icon={<Megaphone size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Net Profit"
            value={fmtMoney(t.total_net_profit)}
            delta={profitDelta}
            deltaLabel={deltaLabel}
            spark={data.kpiSparks.net_profit}
            sparkColor={
              t.total_net_profit >= 0 ? "var(--accent)" : "var(--negative)"
            }
            icon={<TrendingUp size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="ROAS"
            value={t.shopify_ad_spend > 0 ? `${t.roas.toFixed(2)}x` : "—"}
            delta={roasDelta}
            deltaLabel={deltaLabel}
            spark={data.kpiSparks.roas}
            icon={<Crosshair size={14} strokeWidth={1.75} />}
          />
        </div>
      </section>

      {/* ─── SUBSCRIPTION ENGINE ─── */}
      <section>
        <div className="section-eyebrow">
          Subscription engine
          {phx == null ? (
            <span className="sub-warn"> · no PHX sync in range</span>
          ) : null}
        </div>
        <div className="kpi-row">
          <SubCard
            label="Active Subscribers"
            value={activeSubs != null ? activeSubs.toLocaleString() : "—"}
            sub={
              phx == null
                ? "awaiting Solvpath sync"
                : `as of ${phx.range_to ?? phx.scrape_date}`
            }
            icon={<Users size={14} strokeWidth={1.75} />}
          />
          <SubCard
            label="Net New Subs"
            value={netNew != null ? `${netNew >= 0 ? "+" : ""}${netNew}` : "—"}
            sub={
              newSubs != null && cancelledPeriod != null
                ? `${newSubs} new · ${cancelledPeriod} cxl`
                : "awaiting Solvpath sync"
            }
            icon={<ArrowUpRight size={14} strokeWidth={1.75} />}
            visual={
              newSubs != null && cancelledPeriod != null ? (
                <MiniBarChart
                  bars={[
                    { value: newSubs },
                    { value: cancelledPeriod, neg: true },
                  ]}
                />
              ) : null
            }
            tone={netNew != null && netNew >= 0 ? "pos" : netNew != null ? "neg" : undefined}
          />
          <SubCard
            label="Est. MRR"
            value={mrr != null ? fmtMoney(mrr) : "—"}
            sub={
              mrr != null
                ? "projected rebills this month"
                : "awaiting Solvpath sync"
            }
            icon={<LineChart size={14} strokeWidth={1.75} />}
          />
          <SubCard
            label="Stick Rate"
            value={stickRate != null ? `${stickRate.toFixed(1)}%` : "—"}
            sub={
              activeSubs != null && cancelledTotal != null
                ? `${activeSubs.toLocaleString()} / ${(activeSubs + cancelledTotal).toLocaleString()}`
                : "awaiting Solvpath sync"
            }
            icon={<RefreshCcw size={14} strokeWidth={1.75} />}
            tone={
              stickRate != null
                ? stickRate >= 80
                  ? "pos"
                  : stickRate < 60
                    ? "neg"
                    : undefined
                : undefined
            }
          />
        </div>
      </section>

      {/* ─── REVENUE PULSE ─── */}
      <section>
        <div className="section-eyebrow">Revenue pulse</div>
        <RevenueChart data={data.daily} />
        <BreakdownToggle label="Show source breakdown">
          <SourceMixDonut
            shopify={t.shopify_revenue}
            phx={t.phx_revenue}
          />
        </BreakdownToggle>
      </section>

      {/* ─── DAILY P&L ─── (title + controls live inside the card) */}
      <PnlTableWithRange pool={tablePool.daily} />
    </div>
  );
}

function SubCard({
  label,
  value,
  sub,
  icon,
  visual,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  visual?: React.ReactNode;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        <div className="kpi-icon">{icon}</div>
      </div>
      <div
        className="kpi-value"
        style={
          tone === "pos"
            ? { color: "var(--accent)" }
            : tone === "neg"
              ? { color: "var(--negative)" }
              : undefined
        }
      >
        {value}
      </div>
      <div className="kpi-footer">
        {sub ? <span className="kpi-delta-label">{sub}</span> : null}
        {visual ? <div className="kpi-spark">{visual}</div> : null}
      </div>
    </div>
  );
}

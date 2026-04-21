import { loadBlendedDashboardData } from "@/lib/pnl/queries";
import { fmtDate, fmtMoney, fmtPct } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { SourceMixDonut } from "@/components/dashboard/SourceMixDonut";
import { BlendedPnlTable } from "@/components/dashboard/BlendedPnlTable";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import {
  DollarSign,
  Megaphone,
  Zap,
  TrendingUp,
} from "lucide-react";

export const dynamic = "force-dynamic";

const RANGES: Array<{ id: string; label: string; days: number }> = [
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function qs(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

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

  const data = await loadBlendedDashboardData(
    hasCustom ? { from: customFrom!, to: customTo! } : { days: range.days },
  );

  const t = data.periodTotals;
  const p = data.priorPeriodTotals;

  const pct = (curr: number, prev: number | null | undefined): number | null => {
    if (prev == null || prev === 0) return curr === 0 ? 0 : null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const revDelta = pct(t.total_revenue, p?.total_revenue);
  const spendDelta = pct(t.shopify_ad_spend, p?.shopify_ad_spend);
  const roasDelta = pct(t.roas, p?.roas);
  const profitDelta = pct(t.total_net_profit, p?.total_net_profit);

  const phxShare =
    t.total_revenue > 0 ? (t.phx_revenue / t.total_revenue) * 100 : 0;

  const rangeLabel = hasCustom
    ? `${fmtDate(customFrom!)} → ${fmtDate(customTo!)} (${data.range.days} day${data.range.days === 1 ? "" : "s"})`
    : `Last ${range.days} days`;

  return (
    <>
      <div className="pnl-header" style={{ marginBottom: -8 }}>
        <div>
          <h2 className="section-title">
            Total P&amp;L
            <span className="phx-tag" style={{ background: "var(--accent-bg)" }}>
              BLENDED
            </span>
          </h2>
          <div className="section-sub">
            Shopify front-end + PHX recurring · {rangeLabel}
            {data.phxSnapshotsUsed === 0
              ? " · PHX: no snapshots in range"
              : ` · PHX: ${data.phxSnapshotsUsed} snapshot${data.phxSnapshotsUsed === 1 ? "" : "s"}`}
          </div>
        </div>
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

      {/* Period totals strip (bigger, more prominent than KPI cards) */}
      <section className="pnl-totals" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        <TotalTile
          label="Total Revenue"
          value={fmtMoney(t.total_revenue)}
          sub={`${fmtMoney(t.shopify_revenue)} Shopify + ${fmtMoney(t.phx_revenue)} PHX`}
        />
        <TotalTile
          label="Total Ad Spend"
          value={fmtMoney(t.shopify_ad_spend)}
          sub="Shopify-attributed"
        />
        <TotalTile
          label="Blended ROAS"
          value={t.shopify_ad_spend > 0 ? `${t.roas.toFixed(2)}x` : "—"}
          tone={t.roas >= 2 ? "pos" : t.shopify_ad_spend > 0 ? "neg" : undefined}
          sub="total_revenue / ad_spend"
        />
        <TotalTile
          label="Total Net Profit"
          value={fmtMoney(t.total_net_profit)}
          tone={t.total_net_profit >= 0 ? "pos" : "neg"}
          sub={`Margin ${fmtPct(t.margin_pct)}`}
        />
        <TotalTile
          label="PHX share"
          value={t.total_revenue > 0 ? `${phxShare.toFixed(1)}%` : "—"}
          sub={`Recurring ${fmtMoney(t.phx_revenue)}`}
          tone={phxShare >= 30 ? "pos" : undefined}
        />
      </section>

      {/* KPI cards with sparklines for movement — smaller, complementary */}
      <section className="kpi-row">
        <KpiCard
          label={`Revenue · ${data.range.days}d`}
          value={fmtMoney(t.total_revenue)}
          delta={revDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          spark={data.kpiSparks.revenue}
          icon={<DollarSign size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label={`Ad Spend · ${data.range.days}d`}
          value={fmtMoney(t.shopify_ad_spend)}
          delta={spendDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          invert
          spark={data.kpiSparks.ad_spend}
          sparkColor="var(--muted-strong)"
          icon={<Megaphone size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label={`ROAS · ${data.range.days}d`}
          value={t.shopify_ad_spend > 0 ? `${t.roas.toFixed(2)}x` : "—"}
          delta={roasDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          spark={data.kpiSparks.roas}
          icon={<Zap size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label={`Net Profit · ${data.range.days}d`}
          value={fmtMoney(t.total_net_profit)}
          delta={profitDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          spark={data.kpiSparks.net_profit}
          sparkColor={
            t.total_net_profit >= 0 ? "var(--accent)" : "var(--negative)"
          }
          icon={<TrendingUp size={14} strokeWidth={1.75} />}
        />
      </section>

      <section className="chart-row">
        <RevenueChart
          data={data.daily.map((d) => ({
            date: d.date,
            revenue: d.total_revenue,
            cogs: 0,
            fees: 0,
            refunds: 0,
            ad_spend: d.shopify_ad_spend,
            gross_profit: 0,
            net_profit: d.total_net_profit,
            margin_pct: 0,
            order_count: d.shopify_orders,
          }))}
        />
        <SourceMixDonut shopify={t.shopify_revenue} phx={t.phx_revenue} />
      </section>

      <BlendedPnlTable rows={data.tableRows.slice(0, 10)} />
    </>
  );
}

function TotalTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className={`total-tile ${tone ? `tone-${tone}` : ""}`}>
      <div className="total-label">{label}</div>
      <div className="total-value">{value}</div>
      {sub ? (
        <div className="card-sub" style={{ marginTop: 4 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

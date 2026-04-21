import { loadDashboardData } from "@/lib/pnl/queries";
import { fmtDate, fmtMoney } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { StoreMixDonut } from "@/components/dashboard/StoreMixDonut";
import { DailyPnlTable } from "@/components/dashboard/DailyPnlTable";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import { DollarSign, Megaphone, Zap, TrendingUp } from "lucide-react";

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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);
  const range = RANGES.find((r) => r.id === params.range) ?? RANGES[1]; // default 30d

  const data = await loadDashboardData(
    hasCustom ? { from: customFrom!, to: customTo! } : { days: range.days },
  );

  const { periodTotals: t, priorPeriodTotals: p, kpiSparks } = data;

  const pct = (curr: number, prev: number | null | undefined): number | null => {
    if (prev == null || prev === 0) return curr === 0 ? 0 : null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const revDelta = pct(t.revenue, p?.revenue);
  const spendDelta = pct(t.ad_spend, p?.ad_spend);
  const roasDelta = pct(t.roas, p?.roas);
  const profitDelta = pct(t.net_profit, p?.net_profit);

  const rangeLabel = hasCustom
    ? `${fmtDate(customFrom!)} → ${fmtDate(customTo!)} (${data.range.days} day${data.range.days === 1 ? "" : "s"})`
    : `Last ${range.days} days`;

  return (
    <>
      <div className="pnl-header" style={{ marginBottom: -8 }}>
        <div>
          <h2 className="section-title">Dashboard</h2>
          <div className="section-sub">Consolidated · {rangeLabel}</div>
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

      <section className="kpi-row">
        <KpiCard
          label={`Revenue · ${data.range.days}d`}
          value={fmtMoney(t.revenue)}
          delta={revDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          spark={kpiSparks.revenue}
          icon={<DollarSign size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label={`Ad Spend · ${data.range.days}d`}
          value={fmtMoney(t.ad_spend)}
          delta={spendDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          invert
          spark={kpiSparks.ad_spend}
          sparkColor="var(--muted-strong)"
          icon={<Megaphone size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label={`ROAS · ${data.range.days}d`}
          value={t.ad_spend > 0 ? `${t.roas.toFixed(2)}x` : "—"}
          delta={roasDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          spark={kpiSparks.roas}
          icon={<Zap size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label={`Net Profit · ${data.range.days}d`}
          value={fmtMoney(t.net_profit)}
          delta={profitDelta}
          deltaLabel={p ? "vs prior period" : "no prior period"}
          spark={kpiSparks.net_profit}
          sparkColor={
            t.net_profit >= 0 ? "var(--accent)" : "var(--negative)"
          }
          icon={<TrendingUp size={14} strokeWidth={1.75} />}
        />
      </section>

      <section className="chart-row">
        <RevenueChart data={data.series} />
        <StoreMixDonut points={data.storeMix} />
      </section>

      <DailyPnlTable rows={data.tableRows.slice(0, 10)} />
    </>
  );
}

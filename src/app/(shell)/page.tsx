import { loadDashboardData } from "@/lib/pnl/queries";
import { fmtMoney } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { StoreMixDonut } from "@/components/dashboard/StoreMixDonut";
import { DailyPnlTable } from "@/components/dashboard/DailyPnlTable";
import {
  DollarSign,
  Megaphone,
  Zap,
  TrendingUp,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await loadDashboardData();
  const { todayTotals: t, yesterdayTotals: y, kpiSparks } = data;

  const pct = (curr: number, prev: number): number | null => {
    if (prev === 0) return curr === 0 ? 0 : null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const revDelta = pct(t.revenue, y.revenue);
  const spendDelta = pct(t.ad_spend, y.ad_spend);
  const roasDelta = pct(t.roas, y.roas);
  const profitDelta = pct(t.net_profit, y.net_profit);

  return (
    <>
      <section className="kpi-row">
        <KpiCard
          label="Today's Revenue"
          value={fmtMoney(t.revenue)}
          delta={revDelta}
          spark={kpiSparks.revenue}
          icon={<DollarSign size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label="Ad Spend"
          value={fmtMoney(t.ad_spend)}
          delta={spendDelta}
          invert
          spark={kpiSparks.ad_spend}
          sparkColor="var(--muted-strong)"
          icon={<Megaphone size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label="ROAS"
          value={t.ad_spend > 0 ? `${t.roas.toFixed(2)}x` : "—"}
          delta={roasDelta}
          spark={kpiSparks.roas}
          icon={<Zap size={14} strokeWidth={1.75} />}
        />
        <KpiCard
          label="Net Profit"
          value={fmtMoney(t.net_profit)}
          delta={profitDelta}
          spark={kpiSparks.net_profit}
          sparkColor={
            t.net_profit >= 0 ? "var(--accent)" : "var(--negative)"
          }
          icon={<TrendingUp size={14} strokeWidth={1.75} />}
        />
      </section>

      <section className="chart-row">
        <RevenueChart data={data.series30} />
        <StoreMixDonut points={data.storeMixToday} />
      </section>

      <DailyPnlTable rows={data.last10} />
    </>
  );
}

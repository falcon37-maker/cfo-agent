"use client";

// Per-store revenue share — ApexCharts donut. Shows which stores drive revenue
// across the selected window.

import { ApexChart, baseOptions, CHART_COLORS } from "./ApexChart";
import type { ApexOptions } from "apexcharts";

export type StoreSlice = { store: string; revenue: number };

const PALETTE = [
  CHART_COLORS.accent,
  CHART_COLORS.positive,
  CHART_COLORS.warning,
  CHART_COLORS.cyan,
  CHART_COLORS.violet,
  CHART_COLORS.negative,
  CHART_COLORS.accentSoft,
];

export function StoreDonutChart({ data }: { data: StoreSlice[] }) {
  const slices = [...data].filter((d) => d.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const total = slices.reduce((s, d) => s + d.revenue, 0);

  const options: ApexOptions = {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "donut" },
    labels: slices.map((d) => d.store),
    colors: PALETTE.slice(0, slices.length),
    stroke: { width: 0 },
    legend: {
      ...baseOptions().legend,
      position: "bottom",
      formatter: (label, opts) => {
        const idx = opts?.seriesIndex ?? 0;
        const v = slices[idx]?.revenue ?? 0;
        const pct = total > 0 ? Math.round((v / total) * 100) : 0;
        return `${label} · ${pct}%`;
      },
    },
    plotOptions: {
      pie: {
        donut: {
          size: "68%",
          labels: {
            show: true,
            total: {
              show: true,
              label: "Total",
              color: CHART_COLORS.text,
              fontSize: "12px",
              formatter: () => "$" + Math.round(total).toLocaleString(),
            },
            value: {
              color: "#edeef0",
              fontSize: "20px",
              fontWeight: 600,
              formatter: (v) => "$" + Math.round(Number(v)).toLocaleString(),
            },
          },
        },
      },
    },
    tooltip: {
      ...baseOptions().tooltip,
      y: { formatter: (v) => "$" + (v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    },
  };

  return (
    <ApexChart
      type="donut"
      series={slices.map((d) => Math.round(d.revenue * 100) / 100)}
      options={options}
      height={300}
    />
  );
}

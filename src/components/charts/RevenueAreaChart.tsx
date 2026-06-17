"use client";

// Dashboard revenue trend — ApexCharts area chart with gradient fill.
// Replaces the hand-rolled SVG RevenueChart with an interactive, professional
// version (hover tooltips, smooth curve, multi-series toggle via legend).

import { ApexChart, baseOptions, CHART_COLORS } from "./ApexChart";
import type { ApexOptions } from "apexcharts";

export type RevenuePoint = {
  date: string; // YYYY-MM-DD
  revenue: number; // store (Shopify) revenue
  subs: number; // billed subscription revenue
  adSpend: number;
};

export function RevenueAreaChart({ data }: { data: RevenuePoint[] }) {
  const categories = data.map((d) => d.date);
  const options: ApexOptions = {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "area", stacked: false },
    colors: [CHART_COLORS.accent, CHART_COLORS.positive, CHART_COLORS.warning],
    stroke: { curve: "smooth", width: [2.5, 2.5, 2] },
    fill: {
      type: "gradient",
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.35,
        opacityTo: 0.02,
        stops: [0, 90, 100],
      },
    },
    xaxis: {
      categories,
      type: "datetime",
      labels: {
        datetimeUTC: true,
        format: "dd MMM",
        style: { colors: CHART_COLORS.axis, fontSize: "11px" },
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tooltip: { enabled: false },
    },
    yaxis: {
      labels: {
        style: { colors: CHART_COLORS.axis, fontSize: "11px" },
        formatter: (v) => "$" + Math.round(v).toLocaleString(),
      },
    },
    tooltip: {
      ...baseOptions().tooltip,
      x: { format: "ddd, dd MMM yyyy" },
      y: { formatter: (v) => "$" + (v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    },
    legend: { ...baseOptions().legend, position: "top", horizontalAlign: "left" },
  };

  const series = [
    { name: "Store Revenue", data: data.map((d) => d.revenue) },
    { name: "Subs Revenue", data: data.map((d) => d.subs) },
    { name: "Ad Spend", data: data.map((d) => d.adSpend) },
  ];

  return <ApexChart type="area" series={series} options={options} height={300} />;
}

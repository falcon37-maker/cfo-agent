"use client";

// Daily billed subscription revenue (PHX + Paysight rebills) as a column chart.
// Shows the subscription side's day-to-day billing rhythm.

import { ApexChart, baseOptions, CHART_COLORS } from "./ApexChart";
import type { ApexOptions } from "apexcharts";

export type SubsPoint = { date: string; subs: number };

export function SubsTrendChart({ data }: { data: SubsPoint[] }) {
  const options: ApexOptions = {
    ...baseOptions(),
    chart: { ...baseOptions().chart, type: "bar" },
    colors: [CHART_COLORS.accent],
    plotOptions: {
      bar: { borderRadius: 3, columnWidth: "62%" },
    },
    fill: {
      type: "gradient",
      gradient: { shade: "dark", gradientToColors: [CHART_COLORS.violet], opacityFrom: 0.9, opacityTo: 0.75, stops: [0, 100] },
    },
    xaxis: {
      categories: data.map((d) => d.date),
      type: "datetime",
      labels: { datetimeUTC: true, format: "dd MMM", style: { colors: CHART_COLORS.axis, fontSize: "11px" } },
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
  };

  return (
    <ApexChart
      type="bar"
      series={[{ name: "Billed Subs", data: data.map((d) => d.subs) }]}
      options={options}
      height={280}
    />
  );
}

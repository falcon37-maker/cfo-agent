"use client";

// SSR-safe ApexCharts wrapper. ApexCharts touches `window` at import time, so
// it must be loaded client-only via next/dynamic. Every chart in the app goes
// through this so theme defaults (dark, Inter font, indigo accent) stay in one
// place.

import dynamic from "next/dynamic";
import type { ApexOptions } from "apexcharts";

const ReactApexChart = dynamic(() => import("react-apexcharts"), {
  ssr: false,
  loading: () => <div className="chart-skeleton" />,
});

// Shared palette — pulls from the CSS design tokens so charts track the theme.
export const CHART_COLORS = {
  accent: "#6366f1",
  accentSoft: "#818cf8",
  positive: "#10b981",
  negative: "#e11d48",
  warning: "#f59e0b",
  cyan: "#06b6d4",
  violet: "#a855f7",
  grid: "rgba(255,255,255,0.06)",
  axis: "#6b7079",
  text: "#a1a6ad",
};

/** Base options every chart inherits — dark theme, no toolbar clutter,
 *  Inter font, subtle grid. Merge your per-chart options on top. */
export function baseOptions(): ApexOptions {
  return {
    chart: {
      fontFamily: "var(--font-sans), Inter, system-ui, sans-serif",
      foreColor: CHART_COLORS.text,
      toolbar: { show: false },
      zoom: { enabled: false },
      // Animations off: the line/area "mask reveal" animation crashes
      // (Cannot read 'node' of null) when the chart remounts under React
      // Strict Mode / dynamic import. Static render is reliable.
      animations: { enabled: false },
      background: "transparent",
    },
    grid: {
      borderColor: CHART_COLORS.grid,
      strokeDashArray: 4,
      padding: { left: 8, right: 8, top: 0, bottom: 0 },
    },
    dataLabels: { enabled: false },
    tooltip: {
      theme: "dark",
      style: { fontSize: "12px", fontFamily: "var(--font-sans), Inter" },
    },
    legend: {
      labels: { colors: CHART_COLORS.text },
      fontSize: "12px",
      markers: { strokeWidth: 0 },
      itemMargin: { horizontal: 10 },
    },
    states: { hover: { filter: { type: "lighten" } } },
  };
}

// react-apexcharts accepts a narrower `type` union than apexcharts itself
// (no "violin"); keep our public prop to the common chart kinds we use.
type ApexChartType =
  | "line" | "area" | "bar" | "pie" | "donut" | "radialBar"
  | "scatter" | "bubble" | "heatmap" | "candlestick" | "radar"
  | "polarArea" | "rangeBar" | "treemap";

export function ApexChart(props: {
  type: ApexChartType;
  series: ApexOptions["series"];
  options: ApexOptions;
  height?: number | string;
  width?: number | string;
}) {
  const { type, series, options, height = 300, width = "100%" } = props;
  return (
    <ReactApexChart
      type={type}
      series={series}
      options={options}
      height={height}
      width={width}
    />
  );
}

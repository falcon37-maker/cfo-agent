import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Sparkline } from "./Sparkline";

type Props = {
  label: string;
  value: string;
  delta: number | null; // percentage change; null = don't show pill
  deltaLabel?: string;
  spark: number[];
  sparkColor?: string;
  icon: React.ReactNode;
  /** Invert the sign tone (e.g. cancellations: down is good) */
  invert?: boolean;
};

export function KpiCard({
  label,
  value,
  delta,
  deltaLabel = "vs yesterday",
  spark,
  sparkColor = "var(--accent)",
  icon,
  invert = false,
}: Props) {
  const isPositive = delta == null ? null : invert ? delta <= 0 : delta >= 0;

  return (
    <div className="kpi-card">
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        <div className="kpi-icon">{icon}</div>
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-footer">
        {delta != null ? (
          <span className={`kpi-delta ${isPositive ? "pos" : "neg"}`}>
            {isPositive ? (
              <ArrowUpRight size={10} strokeWidth={2.5} />
            ) : (
              <ArrowDownRight size={10} strokeWidth={2.5} />
            )}
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(1)}%
          </span>
        ) : (
          <span className="kpi-delta" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>
            —
          </span>
        )}
        <span className="kpi-delta-label">{deltaLabel}</span>
        <div className="kpi-spark">
          <Sparkline data={spark} color={sparkColor} />
        </div>
      </div>
    </div>
  );
}

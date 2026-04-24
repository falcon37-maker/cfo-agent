// Timeline chart for /chargebacks.
//   - Bars: alert count per day.
//   - Line: 7-day rolling chargeback ratio (alerts_7d / orders_7d * 100).
//   - Dashed red reference line at 1.0% (processor cap).
//
// Hand-rolled SVG to avoid a charting dep, matching the MiniBarChart pattern.

type Day = { date: string; alerts: number; orders: number };

const W = 1000;
const H = 220;
const PAD_L = 44;
const PAD_R = 52;
const PAD_T = 16;
const PAD_B = 30;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const THRESHOLD_PCT = 1.0;

function ratioTone(pct: number): "pos" | "warn" | "neg" {
  if (pct < 0.65) return "pos";
  if (pct < 0.85) return "warn";
  return "neg";
}

export function ChargebacksTimelineChart({ days }: { days: Day[] }) {
  if (days.length === 0) return null;

  // 7-day rolling ratio for each day (trailing window).
  const rolling: number[] = [];
  for (let i = 0; i < days.length; i++) {
    let a = 0;
    let o = 0;
    for (let j = Math.max(0, i - 6); j <= i; j++) {
      a += days[j].alerts;
      o += days[j].orders;
    }
    rolling.push(o > 0 ? (a / o) * 100 : 0);
  }

  const maxAlerts = Math.max(1, ...days.map((d) => d.alerts));
  const peakRatio = Math.max(THRESHOLD_PCT * 1.2, ...rolling);
  // Round up so the top gridline falls on a nice number.
  const yMaxRatio = Math.ceil(peakRatio * 10) / 10;

  const n = days.length;
  const slot = PLOT_W / n;
  const barW = Math.max(2, slot * 0.7);
  const gap = slot - barW;

  // Y scale helpers.
  const yAlerts = (v: number) => PAD_T + PLOT_H - (v / maxAlerts) * PLOT_H;
  const yRatio = (pct: number) => PAD_T + PLOT_H - (pct / yMaxRatio) * PLOT_H;

  // Line path for rolling ratio.
  const linePoints = rolling
    .map((r, i) => `${PAD_L + i * slot + slot / 2},${yRatio(r)}`)
    .join(" ");
  const lineD = `M ${linePoints.replace(/ /g, " L ")}`;

  // Determine rolling line color from the latest value.
  const latest = rolling[rolling.length - 1] ?? 0;
  const tone = ratioTone(latest);
  const lineColor =
    tone === "pos"
      ? "var(--accent)"
      : tone === "warn"
        ? "var(--warning, #ffb020)"
        : "var(--negative)";

  // Sparse X-axis labels — aim for ~8 ticks.
  const tickStep = Math.max(1, Math.ceil(n / 8));
  const xTicks: Array<{ i: number; label: string }> = [];
  for (let i = 0; i < n; i += tickStep) {
    xTicks.push({
      i,
      label: days[i].date.slice(5), // MM-DD
    });
  }

  // Left-axis ticks (count): 0, mid, max.
  const countTicks = [0, Math.round(maxAlerts / 2), maxAlerts];
  // Right-axis ticks (ratio %): 0, mid, max.
  const ratioTicks = [0, yMaxRatio / 2, yMaxRatio];

  const yThreshold = yRatio(THRESHOLD_PCT);

  return (
    <div style={{ width: "100%", overflow: "hidden" }}>
      <svg
        width="100%"
        height="auto"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Chargeback alerts over time"
      >
        {/* Horizontal gridlines (left axis — count). */}
        {countTicks.map((v, idx) => {
          const y = yAlerts(v);
          return (
            <g key={`g${idx}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="var(--border, rgba(255,255,255,0.06))"
                strokeWidth={1}
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
              >
                {v}
              </text>
            </g>
          );
        })}

        {/* Right-axis ratio labels. */}
        {ratioTicks.map((v, idx) => (
          <text
            key={`rt${idx}`}
            x={W - PAD_R + 6}
            y={yRatio(v) + 3}
            textAnchor="start"
            fontSize={10}
            fill="var(--muted)"
          >
            {v.toFixed(2)}%
          </text>
        ))}

        {/* Bars (alert counts). */}
        {days.map((d, i) => {
          const h = (d.alerts / maxAlerts) * PLOT_H;
          return (
            <rect
              key={i}
              x={PAD_L + i * slot + gap / 2}
              y={PAD_T + PLOT_H - h}
              width={barW}
              height={h}
              rx={1.5}
              fill="var(--accent)"
              opacity={0.45}
            />
          );
        })}

        {/* Threshold (red dashed 1%). */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={yThreshold}
          y2={yThreshold}
          stroke="var(--negative)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          opacity={0.9}
        />
        <text
          x={W - PAD_R - 6}
          y={yThreshold - 4}
          textAnchor="end"
          fontSize={10}
          fill="var(--negative)"
          fontWeight={600}
        >
          1.0% cap
        </text>

        {/* Rolling 7-day ratio line. */}
        <path
          d={lineD}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* End-point dot for latest ratio. */}
        {rolling.length > 0 ? (
          <circle
            cx={PAD_L + (n - 1) * slot + slot / 2}
            cy={yRatio(latest)}
            r={3}
            fill={lineColor}
          />
        ) : null}

        {/* X-axis tick labels. */}
        {xTicks.map((t) => (
          <text
            key={t.i}
            x={PAD_L + t.i * slot + slot / 2}
            y={H - 10}
            textAnchor="middle"
            fontSize={10}
            fill="var(--muted)"
          >
            {t.label}
          </text>
        ))}
      </svg>
      <div
        style={{
          display: "flex",
          gap: 18,
          justifyContent: "center",
          fontSize: 11,
          color: "var(--muted)",
          marginTop: 4,
        }}
      >
        <span>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              background: "var(--accent)",
              opacity: 0.45,
              marginRight: 6,
              verticalAlign: "middle",
              borderRadius: 2,
            }}
          />
          Alerts / day
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: 18,
              height: 2,
              background: lineColor,
              marginRight: 6,
              verticalAlign: "middle",
            }}
          />
          7-day ratio (now {latest.toFixed(2)}%)
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: 18,
              height: 2,
              background: "var(--negative)",
              marginRight: 6,
              verticalAlign: "middle",
              backgroundImage:
                "repeating-linear-gradient(90deg, var(--negative) 0 4px, transparent 4px 7px)",
            }}
          />
          1.0% processor cap
        </span>
      </div>
    </div>
  );
}

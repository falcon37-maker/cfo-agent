// Side-by-side monthly bars: gross (full-height accent) and net (shorter,
// lighter overlay). Fees portion is what's between net and gross.

type MonthRow = { ym: string; gross: number; net: number; fees: number };

const W = 1000;
const H = 220;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

function moneyShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(dt);
}

export function FinanceMonthlyTrend({ months }: { months: MonthRow[] }) {
  if (months.length === 0) {
    return (
      <div style={{ color: "var(--muted)", fontSize: 12, textAlign: "center", padding: 24 }}>
        No data yet.
      </div>
    );
  }
  const maxGross = Math.max(1, ...months.map((m) => m.gross));
  const yMax = Math.ceil((maxGross / 1000) * 1.1) * 1000;
  const yScale = (v: number) => PAD_T + PLOT_H - (v / yMax) * PLOT_H;

  const slot = PLOT_W / months.length;
  const groupGap = slot * 0.18;
  const barW = (slot - groupGap) / 2;

  const yTicks = [0, yMax / 2, yMax];

  return (
    <div style={{ width: "100%", overflow: "hidden" }}>
      <svg
        width="100%"
        height="auto"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Monthly gross vs net revenue"
      >
        {yTicks.map((v, idx) => (
          <g key={idx}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="var(--border, rgba(255,255,255,0.06))"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 6}
              y={yScale(v) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted)"
            >
              {moneyShort(v)}
            </text>
          </g>
        ))}
        {months.map((m, i) => {
          const grossH = (m.gross / yMax) * PLOT_H;
          const netH = (Math.max(0, m.net) / yMax) * PLOT_H;
          const xGross = PAD_L + i * slot + groupGap / 2;
          const xNet = xGross + barW;
          return (
            <g key={m.ym}>
              <rect
                x={xGross}
                y={PAD_T + PLOT_H - grossH}
                width={barW}
                height={grossH}
                rx={1.5}
                fill="var(--accent)"
                opacity={0.55}
              />
              <rect
                x={xNet}
                y={PAD_T + PLOT_H - netH}
                width={barW}
                height={netH}
                rx={1.5}
                fill="var(--accent)"
                opacity={0.95}
              />
              <text
                x={xGross + barW}
                y={H - 10}
                textAnchor="middle"
                fontSize={10}
                fill="var(--muted)"
              >
                {monthLabel(m.ym)}
              </text>
            </g>
          );
        })}
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
              opacity: 0.55,
              marginRight: 6,
              verticalAlign: "middle",
              borderRadius: 2,
            }}
          />
          Gross
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              background: "var(--accent)",
              opacity: 0.95,
              marginRight: 6,
              verticalAlign: "middle",
              borderRadius: 2,
            }}
          />
          Net (after fees)
        </span>
      </div>
    </div>
  );
}

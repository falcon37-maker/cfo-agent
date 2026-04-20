import type { DailyRow } from "@/lib/pnl/queries";

// Inline SVG area+line chart. Data is oldest → newest.
export function RevenueChart({ data }: { data: DailyRow[] }) {
  if (data.length < 2) {
    return (
      <div className="card chart-card">
        <div className="card-head">
          <div>
            <div className="card-title">Revenue vs Ad Spend</div>
            <div className="card-sub">Not enough data</div>
          </div>
        </div>
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          Need at least 2 days of data.
        </div>
      </div>
    );
  }

  const W = 640;
  const H = 260;
  const pad = { l: 52, r: 16, t: 20, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const revVals = data.map((d) => d.revenue);
  const spendVals = data.map((d) => d.ad_spend);
  const max = Math.max(...revVals, ...spendVals, 1) * 1.1;
  const min = 0;

  const x = (i: number) => pad.l + (i / (data.length - 1)) * innerW;
  const y = (v: number) => pad.t + innerH - ((v - min) / (max - min)) * innerH;

  const revPath = revVals
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`)
    .join(" ");
  const revArea =
    revPath + ` L${x(data.length - 1)},${pad.t + innerH} L${x(0)},${pad.t + innerH} Z`;
  const spendPath = spendVals
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`)
    .join(" ");

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);
  const fmt = (v: number) => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1000) return `$${(v / 1000).toFixed(0)}k`;
    return `$${Math.round(v)}`;
  };

  // Show ~5 evenly-spaced x-axis labels
  const tickIndexes = [0, 1, 2, 3, 4].map((i) =>
    Math.round((i / 4) * (data.length - 1)),
  );
  const xLabel = (iso: string) => {
    const [, m, d] = iso.split("-").map(Number);
    const months = ["", "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[m]} ${d}`;
  };

  const lastRev = revVals[revVals.length - 1];
  const lastX = x(data.length - 1);
  const lastY = y(lastRev);

  return (
    <div className="card chart-card">
      <div className="card-head">
        <div>
          <div className="card-title">Revenue vs Ad Spend</div>
          <div className="card-sub">Last {data.length} days · all stores</div>
        </div>
        <div className="card-actions">
          <div className="legend">
            <span className="legend-dot" style={{ background: "var(--accent)" }} />
            <span>Revenue</span>
            <span
              className="legend-dot"
              style={{ background: "var(--muted-strong)", marginLeft: 12 }}
            />
            <span>Ad Spend</span>
          </div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        preserveAspectRatio="none"
        style={{ width: "100%", height: 260 }}
      >
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray={i === 0 ? "0" : "2 3"}
            />
            <text
              x={pad.l - 8}
              y={y(v) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
              fontFamily="var(--font-mono)"
            >
              {fmt(v)}
            </text>
          </g>
        ))}
        <path d={revArea} fill="url(#revGrad)" />
        <path
          d={revPath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={spendPath}
          fill="none"
          stroke="var(--muted-strong)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {tickIndexes.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 10}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted)"
            fontFamily="var(--font-mono)"
          >
            {xLabel(data[i].date)}
          </text>
        ))}
        <circle cx={lastX} cy={lastY} r="4" fill="var(--accent)" />
        <circle cx={lastX} cy={lastY} r="8" fill="var(--accent)" opacity="0.18" />
      </svg>
    </div>
  );
}

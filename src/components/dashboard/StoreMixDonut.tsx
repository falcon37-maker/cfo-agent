import type { PerStorePoint } from "@/lib/pnl/queries";
import { fmtMoney } from "@/lib/format";

const COLORS = ["var(--accent)", "var(--accent-dim)", "var(--muted-strong)"];

export function StoreMixDonut({ points }: { points: PerStorePoint[] }) {
  const total = points.reduce((sum, p) => sum + p.revenue, 0);

  if (total <= 0) {
    return (
      <div className="card chart-card">
        <div className="card-head">
          <div>
            <div className="card-title">Revenue by Store</div>
            <div className="card-sub">Today</div>
          </div>
        </div>
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          No revenue recorded today (or latest data day).
        </div>
      </div>
    );
  }

  const R = 70;
  const r = 48;
  const cx = 100;
  const cy = 100;
  const midR = (R + r) / 2;
  const circ = 2 * Math.PI * midR;
  const strokeW = R - r;

  // Sort biggest-first for consistent color assignment
  const legend = points
    .map((p, i) => ({ ...p, _idx: i }))
    .sort((a, b) => b.revenue - a.revenue);

  let offset = 0;
  const arcs = legend.map((p, i) => {
    const frac = p.revenue / total;
    const dash = frac * circ;
    const seg = {
      store: p.store,
      color: COLORS[i % COLORS.length],
      dash,
      gap: circ - dash,
      offset,
      revenue: p.revenue,
      pct: frac * 100,
    };
    offset += dash;
    return seg;
  });

  const centerTotal = fmtMoney(total).replace(/\.\d+$/, "");

  return (
    <div className="card chart-card">
      <div className="card-head">
        <div>
          <div className="card-title">Revenue by Store</div>
          <div className="card-sub">Most recent day</div>
        </div>
      </div>
      <div className="donut-body">
        <svg viewBox="0 0 200 200" width="180" height="180">
          <circle
            cx={cx}
            cy={cy}
            r={midR}
            fill="none"
            stroke="var(--border)"
            strokeWidth={strokeW}
          />
          {arcs.map((a) => (
            <circle
              key={a.store}
              cx={cx}
              cy={cy}
              r={midR}
              fill="none"
              stroke={a.color}
              strokeWidth={strokeW}
              strokeDasharray={`${a.dash} ${a.gap}`}
              strokeDashoffset={-a.offset}
              transform={`rotate(-90 ${cx} ${cy})`}
              strokeLinecap="butt"
            />
          ))}
          <text
            x={cx}
            y={cy - 2}
            textAnchor="middle"
            fontSize="20"
            fill="var(--text)"
            fontFamily="var(--font-mono)"
            fontWeight={600}
          >
            {centerTotal}
          </text>
          <text
            x={cx}
            y={cy + 14}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted)"
          >
            Total
          </text>
        </svg>
        <div className="donut-legend">
          {arcs.map((a) => (
            <div key={a.store} className="dl-row">
              <span className="dl-dot" style={{ background: a.color }} />
              <div className="dl-body">
                <div className="dl-name">{a.store}</div>
                <div className="dl-amt">{fmtMoney(a.revenue)}</div>
              </div>
              <div className="dl-pct">{a.pct.toFixed(0)}%</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

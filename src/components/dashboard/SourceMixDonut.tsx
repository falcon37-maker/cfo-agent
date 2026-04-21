import { fmtMoney } from "@/lib/format";

/**
 * Two-slice donut showing Shopify front-end vs PHX recurring as a share of
 * total revenue over the selected range.
 */
export function SourceMixDonut({
  shopify,
  phx,
}: {
  shopify: number;
  phx: number;
}) {
  const total = shopify + phx;

  if (total <= 0) {
    return (
      <div className="card chart-card">
        <div className="card-head">
          <div>
            <div className="card-title">Revenue by source</div>
            <div className="card-sub">Selected range</div>
          </div>
        </div>
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 12,
          }}
        >
          No revenue in this range.
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

  const slices = [
    {
      label: "Shopify",
      sub: "Direct + initial",
      value: shopify,
      color: "var(--accent)",
    },
    {
      label: "PHX",
      sub: "Recurring + salvage",
      value: phx,
      color: "var(--accent-dim)",
    },
  ]
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  let offset = 0;
  const arcs = slices.map((s) => {
    const frac = s.value / total;
    const dash = frac * circ;
    const seg = {
      ...s,
      dash,
      gap: circ - dash,
      offset,
      pct: frac * 100,
    };
    offset += dash;
    return seg;
  });

  return (
    <div className="card chart-card">
      <div className="card-head">
        <div>
          <div className="card-title">Revenue by source</div>
          <div className="card-sub">Shopify vs Phoenix, selected range</div>
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
              key={a.label}
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
            {fmtMoney(total).replace(/\.\d+$/, "")}
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
            <div key={a.label} className="dl-row">
              <span className="dl-dot" style={{ background: a.color }} />
              <div className="dl-body">
                <div className="dl-name">{a.label}</div>
                <div className="dl-amt">
                  {fmtMoney(a.value)} · {a.sub}
                </div>
              </div>
              <div className="dl-pct">{a.pct.toFixed(0)}%</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

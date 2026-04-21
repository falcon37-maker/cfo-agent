"use client";

import { useMemo, useRef, useState } from "react";
import type { BlendedDailyRow } from "@/lib/pnl/queries";
import { fmtMoney } from "@/lib/format";

type Source = "all" | "shopify" | "phx";

const SOURCES: Array<{ id: Source; label: string }> = [
  { id: "all", label: "All" },
  { id: "shopify", label: "Shopify" },
  { id: "phx", label: "PHX" },
];

const W = 640;
const H = 280;
const PAD = { l: 58, r: 20, t: 26, b: 38 };
const INNER_W = W - PAD.l - PAD.r;
const INNER_H = H - PAD.t - PAD.b;

export function RevenueChart({ data }: { data: BlendedDailyRow[] }) {
  const [source, setSource] = useState<Source>("all");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const revVals = useMemo(() => {
    return data.map((r) => {
      if (source === "shopify") return r.shopify_revenue;
      if (source === "phx") return r.phx_revenue;
      return r.total_revenue;
    });
  }, [data, source]);

  const spendVals = useMemo(
    () => data.map((r) => r.shopify_ad_spend),
    [data],
  );

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

  // Scale: hide the ad-spend line when filter = phx (no ad spend on rebills);
  // otherwise both lines share one y-axis.
  const showAdSpend = source !== "phx";
  const yMax =
    Math.max(
      ...revVals,
      ...(showAdSpend ? spendVals : [0]),
      1,
    ) * 1.12;

  const x = (i: number) => PAD.l + (i / (data.length - 1)) * INNER_W;
  const y = (v: number) => PAD.t + INNER_H - (v / yMax) * INNER_H;

  const revPoints: Array<[number, number]> = revVals.map((v, i) => [x(i), y(v)]);
  const spendPoints: Array<[number, number]> = spendVals.map((v, i) => [x(i), y(v)]);

  const revPath = smoothPath(revPoints);
  const revArea =
    revPath +
    ` L${x(data.length - 1)},${PAD.t + INNER_H} L${x(0)},${PAD.t + INNER_H} Z`;
  const spendPath = smoothPath(spendPoints);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMax * t);

  // 5 evenly spaced x-axis labels.
  const tickIndexes = [0, 1, 2, 3, 4].map((i) =>
    Math.round((i / 4) * (data.length - 1)),
  );

  const revColor =
    source === "phx" ? "var(--accent-dim)" : "var(--accent)";
  const gradId = `revGrad-${source}`;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Convert client X → viewBox X
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = (vx - PAD.l) / INNER_W;
    if (t < 0 || t > 1) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.round(t * (data.length - 1));
    setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
  }

  return (
    <div
      className="card chart-card"
      style={{ position: "relative", gridColumn: "span 2" }}
    >
      <div className="card-head">
        <div>
          <div className="card-title">Revenue vs Ad Spend</div>
          <div className="card-sub">
            {source === "all" && "Blended — Shopify + PHX"}
            {source === "shopify" && "Shopify front-end only"}
            {source === "phx" && "PHX recurring + salvage only"}
            {" · "}last {data.length} day{data.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="card-actions">
          <div className="legend">
            <span className="legend-dot" style={{ background: revColor }} />
            <span>Revenue</span>
            {showAdSpend ? (
              <>
                <span
                  className="legend-dot"
                  style={{ background: "var(--muted-strong)", marginLeft: 12 }}
                />
                <span>Ad Spend</span>
              </>
            ) : null}
          </div>
          <div className="seg" role="tablist" aria-label="Source filter">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={s.id === source ? "active" : ""}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        preserveAspectRatio="none"
        style={{ width: "100%", height: 280 }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={revColor} stopOpacity="0.38" />
            <stop offset="55%" stopColor={revColor} stopOpacity="0.08" />
            <stop offset="100%" stopColor={revColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal grid */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray={i === 0 ? "0" : "3 4"}
              opacity={i === 0 ? 1 : 0.65}
            />
            <text
              x={PAD.l - 10}
              y={y(v) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
              fontFamily="var(--font-mono)"
            >
              {fmtShortMoney(v)}
            </text>
          </g>
        ))}

        {/* Area fill under revenue */}
        <path d={revArea} fill={`url(#${gradId})`} />

        {/* Revenue line (thicker, smoothed) */}
        <path
          d={revPath}
          fill="none"
          stroke={revColor}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Ad spend line (thinner, dashed) */}
        {showAdSpend ? (
          <path
            d={spendPath}
            fill="none"
            stroke="var(--muted-strong)"
            strokeWidth="2"
            strokeDasharray="5 4"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />
        ) : null}

        {/* Hover guide line + dots */}
        {hoverIdx !== null ? (
          <>
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={PAD.t}
              y2={PAD.t + INNER_H}
              stroke="var(--border-strong)"
              strokeWidth="1"
            />
            {showAdSpend ? (
              <circle
                cx={x(hoverIdx)}
                cy={y(spendVals[hoverIdx])}
                r="4"
                fill="var(--muted-strong)"
                stroke="var(--bg)"
                strokeWidth="2"
              />
            ) : null}
            <circle
              cx={x(hoverIdx)}
              cy={y(revVals[hoverIdx])}
              r="5.5"
              fill={revColor}
              stroke="var(--bg)"
              strokeWidth="2"
            />
          </>
        ) : (
          <>
            {/* Last-point focus marker when no hover */}
            <circle
              cx={x(data.length - 1)}
              cy={y(revVals[data.length - 1])}
              r="5"
              fill={revColor}
            />
            <circle
              cx={x(data.length - 1)}
              cy={y(revVals[data.length - 1])}
              r="10"
              fill={revColor}
              opacity="0.18"
            />
          </>
        )}

        {/* X-axis labels */}
        {tickIndexes.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 12}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted)"
            fontFamily="var(--font-mono)"
          >
            {xLabel(data[i].date)}
          </text>
        ))}
      </svg>

      {hoverIdx !== null ? (
        <ChartTip
          row={data[hoverIdx]}
          revVal={revVals[hoverIdx]}
          spendVal={spendVals[hoverIdx]}
          source={source}
          revColor={revColor}
          showAdSpend={showAdSpend}
          xPct={(x(hoverIdx) / W) * 100}
          yPct={(y(revVals[hoverIdx]) / H) * 100}
        />
      ) : null}
    </div>
  );
}

/** Catmull-Rom → cubic Bezier smoothing. Tension 0.5 = gentle. */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${f(cp1x)},${f(cp1y)} ${f(cp2x)},${f(cp2y)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

function fmtShortMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(0)}k`;
  return `$${Math.round(v)}`;
}

function xLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m]} ${d}`;
}

function fullDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(dt);
}

function ChartTip({
  row,
  revVal,
  spendVal,
  source,
  revColor,
  showAdSpend,
  xPct,
  yPct,
}: {
  row: BlendedDailyRow;
  revVal: number;
  spendVal: number;
  source: Source;
  revColor: string;
  showAdSpend: boolean;
  xPct: number;
  yPct: number;
}) {
  const roas = spendVal > 0 ? revVal / spendVal : 0;
  const revLabel =
    source === "all" ? "Total revenue" : source === "shopify" ? "Shopify" : "PHX";

  // Flip tooltip to the other side of the cursor when near the right edge.
  const flipX = xPct > 75;
  const translateX = flipX ? "calc(-100% - 14px)" : "14px";

  return (
    <div
      className="chart-tip"
      style={{
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: `translate(${translateX}, -50%)`,
      }}
    >
      <div className="tip-date">{fullDateLabel(row.date)}</div>

      <div className="tip-row">
        <span className="lbl">
          <span className="tip-dot" style={{ background: revColor }} />
          {revLabel}
        </span>
        <span className="val">{fmtMoney(revVal)}</span>
      </div>

      {source === "all" ? (
        <>
          <div className="tip-row tip-sub">
            <span className="lbl" style={{ paddingLeft: 13 }}>
              Shopify
            </span>
            <span className="val" style={{ color: "var(--muted-strong)" }}>
              {fmtMoney(row.shopify_revenue)}
            </span>
          </div>
          <div className="tip-row tip-sub">
            <span className="lbl" style={{ paddingLeft: 13 }}>
              PHX
            </span>
            <span className="val" style={{ color: "var(--muted-strong)" }}>
              {fmtMoney(row.phx_revenue)}
            </span>
          </div>
        </>
      ) : null}

      {showAdSpend ? (
        <div className="tip-row">
          <span className="lbl">
            <span
              className="tip-dot"
              style={{ background: "var(--muted-strong)" }}
            />
            Ad spend
          </span>
          <span className="val">{fmtMoney(spendVal)}</span>
        </div>
      ) : null}

      <div className="tip-row">
        <span className="lbl">ROAS</span>
        <span
          className="val"
          style={{
            color:
              spendVal === 0
                ? "var(--muted)"
                : roas >= 2
                  ? "var(--accent)"
                  : "var(--negative)",
          }}
        >
          {spendVal > 0 ? `${roas.toFixed(2)}x` : "—"}
        </span>
      </div>

      <div className="tip-row">
        <span className="lbl">Orders</span>
        <span className="val" style={{ color: "var(--muted-strong)" }}>
          {row.shopify_orders}
        </span>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useRef, useState } from "react";
import type { BlendedDailyRow } from "@/lib/pnl/queries";

type SeriesId = "revenue" | "subs" | "shopify" | "ads" | "cogs" | "refunds";

type SeriesDef = {
  id: SeriesId;
  label: string;
  color: string;
  glow: string;
  dashed: boolean;
  pick: (r: BlendedDailyRow) => number;
};

const SERIES: SeriesDef[] = [
  {
    id: "revenue",
    label: "Revenue",
    color: "var(--accent)",
    glow: "rgba(0,212,99,0.45)",
    dashed: false,
    pick: (r) => r.total_revenue,
  },
  {
    id: "subs",
    label: "Subs",
    color: "#6b7bff",
    glow: "rgba(107,123,255,0.40)",
    dashed: false,
    pick: (r) => r.phx_revenue,
  },
  {
    id: "shopify",
    label: "Shopify",
    color: "#2fd4a9",
    glow: "rgba(47,212,169,0.40)",
    dashed: false,
    pick: (r) => r.shopify_revenue,
  },
  {
    id: "ads",
    label: "Ad Spend",
    color: "var(--muted-strong)",
    glow: "rgba(154,160,166,0.35)",
    dashed: true,
    pick: (r) => r.shopify_ad_spend,
  },
  {
    id: "cogs",
    label: "COGS",
    color: "#ffb020",
    glow: "rgba(255,176,32,0.40)",
    dashed: true,
    pick: (r) => r.shopify_cogs,
  },
  {
    id: "refunds",
    label: "Refunds",
    color: "var(--negative)",
    glow: "rgba(255,77,94,0.40)",
    dashed: false,
    pick: (r) => r.shopify_refunds,
  },
];

const W = 760;
const H = 280;
const PAD = { l: 50, r: 18, t: 18, b: 40 };

const AXIS_FONT = "'Lato', -apple-system, BlinkMacSystemFont, sans-serif";
const AXIS_COLOR = "#9ca3af";
const INNER_W = W - PAD.l - PAD.r;
const INNER_H = H - PAD.t - PAD.b;

export function RevenueChart({ data }: { data: BlendedDailyRow[] }) {
  const [active, setActive] = useState<Record<SeriesId, boolean>>({
    revenue: true,
    subs: false,
    shopify: false,
    ads: true,
    cogs: false,
    refunds: false,
  });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const sliced = data;

  // Totals + first-half-vs-second-half delta for the chip badges.
  const { totals, deltas } = useMemo(() => {
    const t = {} as Record<SeriesId, number>;
    const d = {} as Record<SeriesId, number>;
    const mid = Math.floor(sliced.length / 2);
    for (const s of SERIES) {
      let sum = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < sliced.length; i++) {
        const v = s.pick(sliced[i]);
        sum += v;
        if (i < mid) a += v;
        else b += v;
      }
      t[s.id] = sum;
      d[s.id] = a === 0 ? (b === 0 ? 0 : 100) : ((b - a) / a) * 100;
    }
    return { totals: t, deltas: d };
  }, [sliced]);

  const visible = SERIES.filter((s) => active[s.id]);

  if (sliced.length < 2) {
    return (
      <div className="card chart-card chart-modern" style={{ gridColumn: "span 2" }}>
        <div className="card-head chart-head">
          <div>
            <div className="card-title">
              Revenue pulse
              <span className="live-badge">
                <span className="live-dot" />
                LIVE
              </span>
            </div>
            <div className="card-sub">Not enough data to plot</div>
          </div>
        </div>
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          Need at least 2 days of data.
        </div>
      </div>
    );
  }

  const N = sliced.length;
  const allVals = visible.flatMap((s) => sliced.map(s.pick));
  const rawMax = Math.max(1, ...(allVals.length ? allVals : [0]));
  const yMax = rawMax * 1.12;

  const x = (i: number) => PAD.l + (i / (N - 1)) * INNER_W;
  const y = (v: number) => PAD.t + INNER_H - (v / yMax) * INNER_H;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMax * t);
  // X-axis density — always horizontal labels:
  //   7d → every day    |    30d → every 2nd    |    90d → every 7th
  const step = N <= 7 ? 1 : N <= 30 ? 2 : 7;
  const tickIndexes = Array.from({ length: N }, (_, i) => i).filter(
    (i) => i % step === 0,
  );
  if (tickIndexes[tickIndexes.length - 1] !== N - 1) tickIndexes.push(N - 1);

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const rel = (px - PAD.l) / INNER_W;
    if (rel < -0.02 || rel > 1.02) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.round(Math.max(0, Math.min(1, rel)) * (N - 1));
    setHoverIdx(idx);
  }

  const subtitle = visible.length
    ? visible.map((s) => s.label).join(" · ")
    : "No series selected";

  return (
    <div
      className="card chart-card chart-modern"
      style={{ position: "relative", gridColumn: "span 2" }}
    >
      <div className="card-head chart-head">
        <div>
          <div className="card-title">
            Revenue pulse
            <span className="live-badge">
              <span className="live-dot" />
              LIVE
            </span>
          </div>
          <div className="card-sub">
            {subtitle} · last {N} day{N === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div className="filter-rail">
        {SERIES.map((s) => {
          const on = active[s.id];
          const delta = deltas[s.id];
          return (
            <button
              key={s.id}
              type="button"
              className={`filter-chip ${on ? "on" : ""}`}
              onClick={() =>
                setActive((a) => ({ ...a, [s.id]: !a[s.id] }))
              }
              style={
                on
                  ? ({
                      "--chip-color": s.color,
                      "--chip-glow": s.glow,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <span
                className="chip-dot"
                style={{ background: on ? s.color : "var(--muted)" }}
              />
              <span className="chip-label">{s.label}</span>
              <span className="chip-val mono">{fmtShortMoney(totals[s.id])}</span>
              <span
                className={`chip-delta mono ${delta >= 0 ? "pos" : "neg"}`}
              >
                {delta >= 0 ? "▲" : "▼"}
                {Math.abs(delta).toFixed(0)}%
              </span>
            </button>
          );
        })}
      </div>

      <div className="chart-stage">
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
            {SERIES.map((s) => (
              <linearGradient
                key={s.id}
                id={`grad-${s.id}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
                <stop offset="70%" stopColor={s.color} stopOpacity="0.04" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
            {/* Revenue line left→right opacity ramp: faded past, bright now */}
            <linearGradient id="rev-stroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.85" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* y-grid */}
          {yTicks.map((v, i) => (
            <g key={i}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--muted)"
                strokeWidth="1"
                strokeDasharray={i === 0 ? "0" : "2 4"}
                opacity={i === 0 ? 0.12 : 0.05}
              />
              <text
                x={PAD.l - 8}
                y={y(v) + 3}
                textAnchor="end"
                fontSize="10"
                fill={AXIS_COLOR}
                fontFamily={AXIS_FONT}
                fontWeight="400"
                style={{ letterSpacing: "0.01em" }}
              >
                {fmtShortMoney(v)}
              </text>
            </g>
          ))}

          {/* x labels — horizontal only; month prefix on first + month-change ticks */}
          {tickIndexes.map((i, tIdx) => {
            const prev = tIdx > 0 ? tickIndexes[tIdx - 1] : null;
            const label = xLabelSmart(
              sliced.map((r) => r.date),
              i,
              prev,
            );
            return (
              <text
                key={i}
                x={x(i)}
                y={H - 14}
                textAnchor="middle"
                fontSize="10"
                fill={AXIS_COLOR}
                fontFamily={AXIS_FONT}
                fontWeight="400"
                style={{ letterSpacing: "0.01em" }}
              >
                {label}
              </text>
            );
          })}

          {/* series */}
          {visible.map((s, idx) => {
            const pts: Array<[number, number]> = sliced.map((r, i) => [
              x(i),
              y(s.pick(r)),
            ]);
            const path = smoothPath(pts);
            const showArea = idx === 0 && visible.length <= 2;
            const area = `${path} L${x(N - 1)},${PAD.t + INNER_H} L${x(0)},${PAD.t + INNER_H} Z`;
            // Revenue gets the left→right opacity ramp + premium drop shadow.
            // Other primaries keep a solid stroke + subtle glow.
            const isRev = s.id === "revenue";
            const stroke = isRev ? "url(#rev-stroke)" : s.color;
            const filter = isRev
              ? "drop-shadow(0 2px 4px rgba(0,212,99,0.3)) drop-shadow(0 0 6px rgba(0,212,99,0.25))"
              : idx === 0
                ? `drop-shadow(0 0 4px ${s.glow})`
                : undefined;
            return (
              <g key={s.id}>
                {showArea ? <path d={area} fill={`url(#grad-${s.id})`} /> : null}
                <path
                  d={path}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={idx === 0 ? 1.9 : 1.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={s.dashed ? "4 4" : "0"}
                  style={filter ? { filter } : undefined}
                />
              </g>
            );
          })}

          {/* hover guide + dots */}
          {hoverIdx != null ? (
            <g className="hover-layer">
              <line
                x1={x(hoverIdx)}
                x2={x(hoverIdx)}
                y1={PAD.t}
                y2={PAD.t + INNER_H}
                stroke="var(--text-dim)"
                strokeWidth="1"
                strokeDasharray="2 3"
                opacity="0.5"
              />
              {visible.map((s) => (
                <g key={s.id}>
                  <circle
                    cx={x(hoverIdx)}
                    cy={y(s.pick(sliced[hoverIdx]))}
                    r="6"
                    fill={s.color}
                    opacity="0.2"
                  />
                  <circle
                    cx={x(hoverIdx)}
                    cy={y(s.pick(sliced[hoverIdx]))}
                    r="3.5"
                    fill="var(--surface)"
                    stroke={s.color}
                    strokeWidth="2"
                  />
                </g>
              ))}
            </g>
          ) : null}

          {/* live pulse at latest point (first visible series only) */}
          {visible[0] && hoverIdx == null ? (
            (() => {
              const s = visible[0];
              const cx = x(N - 1);
              const cy = y(s.pick(sliced[N - 1]));
              return (
                <g>
                  <circle cx={cx} cy={cy} r="14" fill={s.color} opacity="0.08">
                    <animate
                      attributeName="r"
                      values="8;20;8"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.22;0;0.22"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                  <circle cx={cx} cy={cy} r="8" fill={s.color} opacity="0.22" />
                  <circle
                    cx={cx}
                    cy={cy}
                    r="4"
                    fill={s.color}
                    style={{ filter: `drop-shadow(0 0 6px ${s.glow})` }}
                  />
                  <circle cx={cx} cy={cy} r="1.5" fill="#fff" />
                </g>
              );
            })()
          ) : null}
        </svg>

        {hoverIdx != null ? (
          (() => {
            const leftPct = (x(hoverIdx) / W) * 100;
            const flipLeft = leftPct > 68;
            const rev = visible.find((s) => s.id === "revenue");
            const ads = visible.find((s) => s.id === "ads");
            const roas =
              rev && ads && ads.pick(sliced[hoverIdx]) > 0
                ? rev.pick(sliced[hoverIdx]) / ads.pick(sliced[hoverIdx])
                : null;
            return (
              <div
                className="chart-tooltip"
                style={{
                  left: `${leftPct}%`,
                  transform: flipLeft
                    ? "translate(calc(-100% - 12px), 0)"
                    : "translate(12px, 0)",
                }}
              >
                <div className="tt-date">{fullDateLabel(sliced[hoverIdx].date)}</div>
                <div className="tt-rows">
                  {visible.length === 0 ? (
                    <div className="tt-empty">No series selected</div>
                  ) : (
                    visible.map((s) => (
                      <div key={s.id} className="tt-row">
                        <span
                          className="tt-dot"
                          style={{ background: s.color }}
                        />
                        <span className="tt-label">{s.label}</span>
                        <span className="tt-val mono">
                          {fmtFullMoney(s.pick(sliced[hoverIdx]))}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {roas != null ? (
                  <div className="tt-foot">
                    <span>ROAS</span>
                    <span
                      className="mono"
                      style={{
                        color:
                          roas >= 3 ? "var(--accent)" : "var(--negative)",
                      }}
                    >
                      {roas.toFixed(2)}x
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })()
        ) : null}
      </div>
    </div>
  );
}

/** Catmull-Rom → cubic Bezier smoothing. */
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
  if (v >= 1000) {
    const digits = v >= 10_000 ? 0 : 1;
    const s = (v / 1000).toFixed(digits);
    // Drop trailing .0 → "$2.0k" becomes "$2k"
    return `$${digits > 0 && s.endsWith(".0") ? s.slice(0, -2) : s}k`;
  }
  return `$${Math.round(v)}`;
}

function fmtFullMoney(v: number): string {
  return "$" + Math.round(v).toLocaleString();
}

const MONTHS = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Smart tick label. Returns just the day number ("23", "25")
 * except on the first visible tick and whenever the month changes
 * from the previous visible tick — then prefix with the month ("Mar 23").
 */
function xLabelSmart(dates: string[], tickIdx: number, prevTickIdx: number | null): string {
  const [, m, d] = dates[tickIdx].split("-").map(Number);
  if (prevTickIdx == null) return `${MONTHS[m]} ${d}`;
  const prevM = Number(dates[prevTickIdx].split("-")[1]);
  if (m !== prevM) return `${MONTHS[m]} ${d}`;
  return String(d);
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

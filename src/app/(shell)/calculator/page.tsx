"use client";

import { useMemo, useState } from "react";
import { fmtMoney, fmtPct } from "@/lib/format";

// Unit-economics calculator: given price, COGS, fees, CAC, and monthly
// retention rate, compute breakeven ROAS, LTV at 3/6/12 months, cumulative
// profit per customer by month, and a 12-month profit curve.

type Inputs = {
  price: number;
  cogs: number;
  feeRatePct: number;
  retentionPct: number;
  cac: number;
};

type MonthPoint = {
  month: number;
  cumContribution: number;
  cumProfit: number;
};

type Results = {
  contributionPerOrder: number;
  contributionMarginPct: number;
  breakevenRoas: number | null;
  ltv3: number;
  ltv6: number;
  ltv12: number;
  profit3: number;
  profit6: number;
  profit12: number;
  breakevenMonth: number | null;
  months: MonthPoint[];
};

function compute(i: Inputs): Results {
  const feeRate = i.feeRatePct / 100;
  const retention = i.retentionPct / 100;

  const contribution = i.price * (1 - feeRate) - i.cogs;
  const contributionMarginPct = i.price > 0 ? (contribution / i.price) * 100 : 0;

  // Breakeven ROAS = price / contribution (ROAS that covers ad spend given
  // per-order gross margin). Undefined when contribution is non-positive.
  const breakevenRoas =
    contribution > 0 ? i.price / contribution : null;

  const months: MonthPoint[] = [];
  let breakevenMonth: number | null = null;
  for (let m = 1; m <= 12; m++) {
    // Expected orders over m months = 1 + r + r² + … + r^(m-1).
    const series =
      retention === 1 ? m : (1 - Math.pow(retention, m)) / (1 - retention);
    const cumContribution = contribution * series;
    const cumProfit = cumContribution - i.cac;
    months.push({ month: m, cumContribution, cumProfit });
    if (breakevenMonth == null && cumProfit >= 0) breakevenMonth = m;
  }

  const ltvAt = (n: number) => months[n - 1]?.cumContribution ?? 0;
  const profitAt = (n: number) => months[n - 1]?.cumProfit ?? 0;

  return {
    contributionPerOrder: contribution,
    contributionMarginPct,
    breakevenRoas,
    ltv3: ltvAt(3),
    ltv6: ltvAt(6),
    ltv12: ltvAt(12),
    profit3: profitAt(3),
    profit6: profitAt(6),
    profit12: profitAt(12),
    breakevenMonth,
    months,
  };
}

const DEFAULTS: Inputs = {
  price: 99.99,
  cogs: 20,
  feeRatePct: 10,
  retentionPct: 75,
  cac: 30,
};

export default function CalculatorPage() {
  const [inputs, setInputs] = useState<Inputs>(DEFAULTS);
  const r = useMemo(() => compute(inputs), [inputs]);

  function update<K extends keyof Inputs>(key: K, value: number) {
    setInputs((prev) => ({ ...prev, [key]: Number.isFinite(value) ? value : 0 }));
  }

  return (
    <>
      <div>
        <h2 className="section-title">Unit Economics Calculator</h2>
        <div className="section-sub">
          Live simulator — change any input and everything recomputes instantly.
          Defaults match NOVA&apos;s current numbers.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: 20,
          alignItems: "flex-start",
        }}
      >
        {/* ─── Inputs ─── */}
        <div className="card" style={{ padding: 20 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 14,
            }}
          >
            Inputs
          </div>

          <NumberField
            label="Sale price (AOV)"
            value={inputs.price}
            onChange={(v) => update("price", v)}
            prefix="$"
            step={0.01}
          />
          <NumberField
            label="COGS per order"
            value={inputs.cogs}
            onChange={(v) => update("cogs", v)}
            prefix="$"
            step={0.01}
          />
          <NumberField
            label="Processing fee rate"
            value={inputs.feeRatePct}
            onChange={(v) => update("feeRatePct", v)}
            suffix="%"
            step={0.1}
          />
          <NumberField
            label="Monthly retention"
            value={inputs.retentionPct}
            onChange={(v) => update("retentionPct", v)}
            suffix="%"
            step={1}
            min={0}
            max={100}
          />
          <NumberField
            label="CAC (ad spend / new customer)"
            value={inputs.cac}
            onChange={(v) => update("cac", v)}
            prefix="$"
            step={0.5}
          />

          <button
            type="button"
            onClick={() => setInputs(DEFAULTS)}
            className="ghost-btn"
            style={{ marginTop: 6, width: "100%", justifyContent: "center" }}
          >
            Reset to NOVA defaults
          </button>
        </div>

        {/* ─── Outputs ─── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Headline row */}
          <div className="pnl-totals" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
            <TotalTile
              label="Contribution / order"
              value={fmtMoney(r.contributionPerOrder)}
              tone={r.contributionPerOrder > 0 ? "pos" : "neg"}
              sub={`${r.contributionMarginPct.toFixed(1)}% margin`}
            />
            <TotalTile
              label="Breakeven ROAS"
              value={
                r.breakevenRoas != null ? `${r.breakevenRoas.toFixed(2)}x` : "∞"
              }
              tone={r.breakevenRoas != null && r.breakevenRoas <= 3 ? "pos" : "neg"}
              sub="per-order, pre-retention"
            />
            <TotalTile
              label="Breakeven on ad spend"
              value={
                r.breakevenMonth != null ? `Month ${r.breakevenMonth}` : "Never"
              }
              tone={
                r.breakevenMonth == null
                  ? "neg"
                  : r.breakevenMonth <= 3
                    ? "pos"
                    : r.breakevenMonth <= 6
                      ? undefined
                      : "neg"
              }
              sub="when LTV ≥ CAC"
            />
            <TotalTile
              label="LTV / CAC (12 mo)"
              value={
                inputs.cac > 0 ? `${(r.ltv12 / inputs.cac).toFixed(2)}x` : "—"
              }
              tone={inputs.cac > 0 && r.ltv12 / inputs.cac >= 3 ? "pos" : "neg"}
            />
          </div>

          {/* 3/6/12 comparison table */}
          <div className="card table-card">
            <div className="card-head">
              <div>
                <div className="card-title">LTV &amp; profit per customer</div>
                <div className="card-sub">
                  Cumulative contribution and net profit after CAC, by month
                </div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="pnl-table">
                <thead>
                  <tr>
                    <th>Horizon</th>
                    <th className="num">LTV</th>
                    <th className="num">Profit (LTV − CAC)</th>
                    <th className="num">Return on CAC</th>
                  </tr>
                </thead>
                <tbody>
                  <HorizonRow
                    label="3 months"
                    ltv={r.ltv3}
                    profit={r.profit3}
                    cac={inputs.cac}
                  />
                  <HorizonRow
                    label="6 months"
                    ltv={r.ltv6}
                    profit={r.profit6}
                    cac={inputs.cac}
                  />
                  <HorizonRow
                    label="12 months"
                    ltv={r.ltv12}
                    profit={r.profit12}
                    cac={inputs.cac}
                  />
                </tbody>
              </table>
            </div>
          </div>

          <ProfitCurveCard
            months={r.months}
            cac={inputs.cac}
            breakevenMonth={r.breakevenMonth}
          />
        </div>
      </div>
    </>
  );
}

function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 7,
          padding: "6px 10px",
        }}
      >
        {prefix ? (
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            {prefix}
          </span>
        ) : null}
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            flex: 1,
            background: "transparent",
            border: 0,
            outline: "none",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
            minWidth: 0,
          }}
        />
        {suffix ? (
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            {suffix}
          </span>
        ) : null}
      </div>
    </label>
  );
}

function TotalTile({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
  sub?: string;
}) {
  return (
    <div className={`total-tile ${tone ? `tone-${tone}` : ""}`}>
      <div className="total-label">{label}</div>
      <div className="total-value">{value}</div>
      {sub ? (
        <div className="card-sub" style={{ marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function HorizonRow({
  label,
  ltv,
  profit,
  cac,
}: {
  label: string;
  ltv: number;
  profit: number;
  cac: number;
}) {
  const ratio = cac > 0 ? ltv / cac : 0;
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmtMoney(ltv)}</td>
      <td className={`num profit ${profit >= 0 ? "pos" : "neg"}`}>
        <span className="profit-pill">{fmtMoney(profit)}</span>
      </td>
      <td
        className={`num ${ratio >= 3 ? "roas pos" : ratio >= 1 ? "" : "roas neg"}`}
      >
        {cac > 0 ? `${ratio.toFixed(2)}x` : "—"}
      </td>
    </tr>
  );
}

function ProfitCurveCard({
  months,
  cac,
  breakevenMonth,
}: {
  months: MonthPoint[];
  cac: number;
  breakevenMonth: number | null;
}) {
  const W = 680;
  const H = 260;
  const pad = { l: 56, r: 16, t: 20, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const yMin = Math.min(0, ...months.map((m) => m.cumProfit));
  const yMax = Math.max(0, ...months.map((m) => m.cumProfit));
  const yPad = (yMax - yMin) * 0.08 || 1;
  const lo = yMin - yPad;
  const hi = yMax + yPad;

  const x = (m: number) => pad.l + ((m - 1) / 11) * innerW;
  const y = (v: number) => pad.t + innerH - ((v - lo) / (hi - lo)) * innerH;
  const y0 = y(0);

  const path = months
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.month)},${y(p.cumProfit)}`)
    .join(" ");

  const areaDown = `M${x(1)},${y0} ` +
    months.map((p) => `L${x(p.month)},${y(p.cumProfit)}`).join(" ") +
    ` L${x(12)},${y0} Z`;

  const yTicks = [lo, lo + (hi - lo) * 0.25, (lo + hi) / 2, lo + (hi - lo) * 0.75, hi];
  const fmt = (v: number) => {
    const abs = Math.abs(v);
    const s = v < 0 ? "-" : "";
    if (abs >= 1000) return `${s}$${(abs / 1000).toFixed(1)}k`;
    return `${s}$${Math.round(abs)}`;
  };

  const lastProfit = months[months.length - 1].cumProfit;
  const stroke = lastProfit >= 0 ? "var(--accent)" : "var(--negative)";

  return (
    <div className="card chart-card">
      <div className="card-head">
        <div>
          <div className="card-title">Cumulative profit curve</div>
          <div className="card-sub">
            Net profit per acquired customer by month (after CAC recovery)
          </div>
        </div>
        <div className="legend">
          <span className="legend-dot" style={{ background: stroke }} />
          <span>Cumulative profit</span>
          {breakevenMonth ? (
            <>
              <span
                className="legend-dot"
                style={{
                  background: "var(--warning)",
                  marginLeft: 12,
                }}
              />
              <span>Breakeven M{breakevenMonth}</span>
            </>
          ) : null}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        preserveAspectRatio="none"
        style={{ width: "100%", height: 260 }}
      >
        <defs>
          <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
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

        {/* Zero axis if in view */}
        {lo < 0 && hi > 0 ? (
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y0}
            y2={y0}
            stroke="var(--border-strong)"
            strokeWidth="1.5"
          />
        ) : null}

        {/* -CAC reference */}
        {cac > 0 && -cac >= lo && -cac <= hi ? (
          <g>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(-cac)}
              y2={y(-cac)}
              stroke="var(--muted)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <text
              x={W - pad.r}
              y={y(-cac) - 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
              fontFamily="var(--font-mono)"
            >
              −CAC
            </text>
          </g>
        ) : null}

        <path d={areaDown} fill="url(#profitGrad)" />
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Month labels */}
        {[1, 3, 6, 9, 12].map((m) => (
          <text
            key={m}
            x={x(m)}
            y={H - 10}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted)"
            fontFamily="var(--font-mono)"
          >
            M{m}
          </text>
        ))}

        {/* Breakeven marker */}
        {breakevenMonth ? (
          <g>
            <line
              x1={x(breakevenMonth)}
              x2={x(breakevenMonth)}
              y1={pad.t}
              y2={pad.t + innerH}
              stroke="var(--warning)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={x(breakevenMonth)}
              cy={y0}
              r="4"
              fill="var(--warning)"
            />
          </g>
        ) : null}

        {/* Last-point dot */}
        <circle
          cx={x(12)}
          cy={y(lastProfit)}
          r="4"
          fill={stroke}
        />
      </svg>
      <div
        style={{
          padding: "12px 18px",
          fontSize: 12,
          color: "var(--muted)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <span>
          12-month LTV:{" "}
          <span
            style={{
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
            }}
          >
            {fmtMoney(months[11].cumContribution)}
          </span>
        </span>
        <span>
          12-month profit:{" "}
          <span
            style={{
              color: lastProfit >= 0 ? "var(--accent)" : "var(--negative)",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
            }}
          >
            {fmtMoney(lastProfit)}
          </span>
        </span>
        <span>
          Implied margin:{" "}
          <span
            style={{
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
            }}
          >
            {months[11].cumContribution > 0
              ? fmtPct((lastProfit / months[11].cumContribution) * 100)
              : "—"}
          </span>
        </span>
      </div>
    </div>
  );
}

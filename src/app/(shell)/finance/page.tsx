// /finance — the "what actually landed in the bank" view.
// Pulls revenue from daily_pnl + phx_summary_snapshots, deductions from
// daily_pnl.fees/refunds + chargeblast_alerts + a PHX gateway-fee estimate.

import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadStores } from "@/lib/pnl/queries";
import { loadPhxDailyRows } from "@/lib/phx/queries";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import { FinanceMonthlyTrend } from "@/components/finance/MonthlyTrend";
import {
  DollarSign,
  Scissors,
  Landmark,
  Percent,
  Wallet,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Finance — CFO Agent" };

const PHX_STORE_IDS = new Set(["NOVA", "NURA", "KOVA"]);
const PHX_FEE_RATE_FALLBACK = 0.1; // 10% — same fallback as the dashboard
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const RANGES: Array<{ id: string; days: number }> = [
  { id: "7d", days: 7 },
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
];

// ── helpers ────────────────────────────────────────────────────────────────

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function qs(p: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}
function parseStoreList(raw: string): string[] {
  if (!raw || raw.toLowerCase() === "all") return [];
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

type PnlRow = {
  store_id: string;
  date: string;
  revenue: number | string | null;
  cogs: number | string | null;
  fees: number | string | null;
  refunds: number | string | null;
  ad_spend: number | string | null;
  order_count: number | null;
};
const num = (v: number | string | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

async function loadPnlInRange(
  from: string,
  to: string,
  storeIds: string[],
): Promise<PnlRow[]> {
  const sb = supabaseAdmin();
  let q = sb
    .from("daily_pnl")
    .select("store_id, date, revenue, cogs, fees, refunds, ad_spend, order_count")
    .gte("date", from)
    .lte("date", to);
  if (storeIds.length > 0) q = q.in("store_id", storeIds);
  const { data, error } = await q;
  if (error) throw new Error(`loadPnlInRange: ${error.message}`);
  return (data ?? []) as PnlRow[];
}

async function loadAlertsInRange(
  from: string,
  to: string,
): Promise<Array<{ amount: number | null; store_id: string | null }>> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("chargeblast_alerts")
    .select("amount, store_id")
    .gte("chargeblast_created_at", `${from}T00:00:00Z`)
    .lte("chargeblast_created_at", `${to}T23:59:59Z`);
  if (error) return [];
  return (data ?? []) as Array<{ amount: number | null; store_id: string | null }>;
}

// ── page ───────────────────────────────────────────────────────────────────

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    store?: string;
  }>;
}) {
  const params = await searchParams;
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);
  const range = RANGES.find((r) => r.id === params.range) ?? RANGES[1];
  const selected = parseStoreList(params.store ?? "");
  const activeParam = selected.slice().sort().join(",");

  const to = hasCustom ? customTo! : todayUtc();
  const from = hasCustom ? customFrom! : addDays(to, -(range.days - 1));
  const rangeLabel = hasCustom
    ? `${fmtDate(from)} → ${fmtDate(to)}`
    : `Last ${range.days} days`;

  // Resolve which stores feed each side (Shopify-direct vs PHX-source).
  const stores = await loadStores();
  const phxStores = stores
    .map((s) => s.id)
    .filter((id) => PHX_STORE_IDS.has(id));
  const selectedPhxStores =
    selected.length === 0
      ? phxStores
      : phxStores.filter((id) => selected.includes(id));

  const feeRate =
    Number(stores.find((s) => s.id !== "PORTFOLIO")?.processing_fee_pct ?? PHX_FEE_RATE_FALLBACK) ||
    PHX_FEE_RATE_FALLBACK;

  // Pull range data in parallel.
  const [pnl, phxDays, alerts, monthlyPnl, monthlyPhx] = await Promise.all([
    loadPnlInRange(from, to, selected),
    loadPhxDailyRows(from, to, selectedPhxStores),
    loadAlertsInRange(from, to),
    // Monthly trend — last 12 calendar months.
    (async () => {
      const trendFrom = addDays(to, -365);
      return loadPnlInRange(trendFrom, to, selected);
    })(),
    (async () => {
      const trendFrom = addDays(to, -365);
      return loadPhxDailyRows(trendFrom, to, selectedPhxStores);
    })(),
  ]);

  // ── Revenue by source ────────────────────────────────────────────────────
  // Shopify frontend = sum daily_pnl.revenue for non-PHX stores in selection
  //                    (PHX stores' revenue lives in phx_summary_snapshots).
  let shopifyFrontendRev = 0;
  let shopifyFrontendOrders = 0;
  let shopifyFees = 0;
  let shopifyRefunds = 0;
  let shopifyAdSpend = 0;
  let shopifyCogs = 0;
  for (const r of pnl) {
    const isPhx = PHX_STORE_IDS.has(r.store_id);
    if (!isPhx) {
      shopifyFrontendRev += num(r.revenue);
      shopifyFrontendOrders += r.order_count ?? 0;
    }
    // Fees/refunds/ad_spend/cogs apply across all stores in selection
    // (PHX stores still log Shopify-side ad spend / cogs — those are real).
    shopifyFees += num(r.fees);
    shopifyRefunds += num(r.refunds);
    shopifyAdSpend += num(r.ad_spend);
    shopifyCogs += num(r.cogs);
  }

  let phxDirect = 0;
  let phxInitial = 0;
  let phxRecurring = 0;
  let phxSalvage = 0;
  let phxUpsell = 0;
  let phxDirectCount = 0;
  let phxInitialCount = 0;
  let phxRecurringCount = 0;
  let phxSalvageCount = 0;
  for (const r of phxDays) {
    phxDirect += num(r.revenue_direct);
    phxInitial += num(r.revenue_initial);
    phxRecurring += num(r.revenue_recurring);
    phxSalvage += num(r.revenue_salvage);
    phxUpsell += num(r.revenue_upsell);
    const j = (r.raw_json as Record<string, unknown> | null) ?? {};
    phxDirectCount += Number(j.directCount ?? 0);
    phxInitialCount += Number(j.initialCount ?? 0);
    phxRecurringCount += Number(j.recurringCount ?? 0);
    phxSalvageCount += Number(j.salvageCount ?? 0);
  }
  const phxTotal = phxDirect + phxInitial + phxRecurring + phxSalvage + phxUpsell;
  const grossRevenue = shopifyFrontendRev + phxTotal;

  // ── Fees & deductions ────────────────────────────────────────────────────
  const phxGatewayFees = phxTotal * feeRate;
  const alertCost = alerts.reduce((s, a) => s + Number(a.amount ?? 0), 0);
  const totalDeductions =
    shopifyFees + phxGatewayFees + alertCost + shopifyRefunds;
  const netRevenue = grossRevenue - totalDeductions;
  const effectiveFeeRate =
    grossRevenue > 0 ? (totalDeductions / grossRevenue) * 100 : 0;

  // Net Cash position estimate — gross minus all real costs (ad spend + cogs
  // included). We don't have bank balances, so this is a best-effort "money
  // left after everything visible".
  const netCashEstimate = netRevenue - shopifyAdSpend - shopifyCogs;

  // ── Monthly trend — group by YYYY-MM ─────────────────────────────────────
  const monthly = buildMonthlyTrend(monthlyPnl, monthlyPhx, feeRate);

  // ── chips href builders ──────────────────────────────────────────────────
  const chipHrefAll = `/finance${qs({
    range: hasCustom ? "" : range.id,
    from: hasCustom ? customFrom! : "",
    to: hasCustom ? customTo! : "",
  })}`;
  const buildToggleHref = (storeId: string): string => {
    const next = new Set(selected);
    if (next.has(storeId)) next.delete(storeId);
    else next.add(storeId);
    const param = Array.from(next).sort().join(",");
    return `/finance${qs({
      range: hasCustom ? "" : range.id,
      from: hasCustom ? customFrom! : "",
      to: hasCustom ? customTo! : "",
      store: param,
    })}`;
  };

  const feeRows = [
    {
      label: "Processing Fees (PayArc / Shopify)",
      amount: shopifyFees,
      note: "From daily_pnl.fees on Shopify-side stores",
    },
    {
      label: "Gateway Fees (PHX / Solvpath)",
      amount: phxGatewayFees,
      note: `Estimated · ${(feeRate * 100).toFixed(1)}% of PHX revenue`,
    },
    {
      label: "Chargeblast Alert Costs",
      amount: alertCost,
      note: `${alerts.length} alert${alerts.length === 1 ? "" : "s"} in window`,
    },
    {
      label: "Refunds",
      amount: shopifyRefunds,
      note: "From daily_pnl.refunds (Shopify-side)",
    },
  ];

  const sourceRows: Array<{
    label: string;
    revenue: number;
    orders: number;
  }> = [
    {
      label: "Shopify Frontend (non-PHX stores)",
      revenue: shopifyFrontendRev,
      orders: shopifyFrontendOrders,
    },
    { label: "PHX Direct Sale", revenue: phxDirect, orders: phxDirectCount },
    { label: "PHX Initial Subscription", revenue: phxInitial, orders: phxInitialCount },
    { label: "PHX Recurring", revenue: phxRecurring, orders: phxRecurringCount },
    { label: "PHX Salvage", revenue: phxSalvage, orders: phxSalvageCount },
  ];
  if (phxUpsell > 0) {
    sourceRows.push({ label: "PHX Upsell", revenue: phxUpsell, orders: 0 });
  }

  return (
    <div className="dashboard-narrow">
      <div className="pnl-header" style={{ alignItems: "center" }}>
        <div>
          <div className="greet-eyebrow">Finance</div>
          <h1 className="greet-title">
            <Landmark size={18} strokeWidth={2} /> {rangeLabel}
          </h1>
          <div className="section-sub" style={{ marginTop: 4 }}>
            What actually landed in the bank vs. what got pulled in fees,
            chargebacks, and platform charges.{" "}
            {selected.length === 0
              ? "All stores"
              : selected.length === 1
                ? selected[0]
                : `${selected.length} stores selected`}
          </div>
        </div>
        <div className="pnl-controls">
          <div className="seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/finance${qs({
                  range: r.id,
                  store: activeParam,
                })}`}
              >
                {r.id}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/finance${qs({
                store: activeParam,
                from: customFrom ?? from,
                to: customTo ?? to,
              })}`}
            >
              Custom
            </SegLink>
          </div>
          <DateRangeForm
            action="/finance"
            from={customFrom ?? from}
            to={customTo ?? to}
            hidden={{ store: activeParam }}
          />
          <div
            role="group"
            aria-label="Stores"
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <Link
              href={chipHrefAll}
              className={`store-chip ${selected.length === 0 ? "active" : ""}`}
              prefetch={false}
            >
              All
            </Link>
            {stores
              .filter((s) => s.id !== "PORTFOLIO" && s.id !== "__BACKFILL_DEDUPE__")
              .map((s) => {
                const isOn = selected.includes(s.id);
                return (
                  <Link
                    key={s.id}
                    href={buildToggleHref(s.id)}
                    className={`store-chip ${isOn ? "active" : ""}`}
                    prefetch={false}
                  >
                    {s.id}
                  </Link>
                );
              })}
          </div>
        </div>
      </div>

      {/* ── KPIs ── */}
      <section>
        <div className="section-eyebrow">Cash signal</div>
        <div className="kpi-row kpi-5">
          <KpiCard
            label="Gross Revenue"
            value={fmtMoney(grossRevenue)}
            delta={null}
            deltaLabel="Shopify + PHX in range"
            spark={[]}
            icon={<DollarSign size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Total Fees & Deductions"
            value={fmtMoney(totalDeductions)}
            delta={null}
            deltaLabel="processing + gateway + alerts + refunds"
            spark={[]}
            sparkColor="var(--negative)"
            invert
            icon={<Scissors size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Net Revenue"
            value={fmtMoney(netRevenue)}
            delta={null}
            deltaLabel="gross − all deductions"
            spark={[]}
            sparkColor={netRevenue >= 0 ? "var(--accent)" : "var(--negative)"}
            icon={<Landmark size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Effective Fee Rate"
            value={`${effectiveFeeRate.toFixed(2)}%`}
            delta={null}
            deltaLabel="deductions / gross"
            spark={[]}
            icon={<Percent size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Net Cash (est.)"
            value={fmtMoney(netCashEstimate)}
            delta={null}
            deltaLabel="net rev − ad spend − COGS"
            spark={[]}
            sparkColor={
              netCashEstimate >= 0 ? "var(--accent)" : "var(--negative)"
            }
            icon={<Wallet size={14} strokeWidth={1.75} />}
          />
        </div>
      </section>

      {/* ── Monthly trend ── */}
      <section>
        <div className="section-eyebrow">Monthly trend · last 12 months</div>
        <div className="card" style={{ padding: 16 }}>
          <FinanceMonthlyTrend months={monthly} />
        </div>
      </section>

      {/* ── Fee breakdown ── */}
      <section>
        <div className="section-eyebrow">Fee breakdown</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th className="num">% of Gross</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {feeRows.map((r) => {
                  const pct =
                    grossRevenue > 0 ? (r.amount / grossRevenue) * 100 : 0;
                  return (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="num">{fmtMoney(r.amount)}</td>
                      <td className="num muted">{pct.toFixed(2)}%</td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {r.note}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="tfoot-row">
                  <td>Total Deductions</td>
                  <td className="num">{fmtMoney(totalDeductions)}</td>
                  <td className="num">{effectiveFeeRate.toFixed(2)}%</td>
                  <td />
                </tr>
                <tr className="tfoot-row">
                  <td>Net After Deductions</td>
                  <td className="num">{fmtMoney(netRevenue)}</td>
                  <td className="num">
                    {(100 - effectiveFeeRate).toFixed(2)}%
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      {/* ── Revenue by source ── */}
      <section>
        <div className="section-eyebrow">Revenue by source</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Gross Revenue</th>
                  <th className="num">Orders</th>
                  <th className="num">Avg Order Value</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((r) => {
                  const aov = r.orders > 0 ? r.revenue / r.orders : 0;
                  return (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="num">
                        {r.revenue > 0 ? fmtMoney(r.revenue) : "—"}
                      </td>
                      <td className="num muted">{fmtInt(r.orders)}</td>
                      <td className="num muted">
                        {aov > 0 ? fmtMoney(aov) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="tfoot-row">
                  <td>Total</td>
                  <td className="num">{fmtMoney(grossRevenue)}</td>
                  <td className="num">
                    {fmtInt(
                      sourceRows.reduce((s, r) => s + r.orders, 0),
                    )}
                  </td>
                  <td className="num">—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <div className="section-sub" style={{ marginTop: 6, fontSize: 11 }}>
          Order counts on PHX rows come from per-store snapshot raw_json
          (directCount / initialCount / recurringCount / salvageCount). Days
          where the snapshot didn&apos;t store counts contribute revenue but
          no order count.
        </div>
      </section>

    </div>
  );
}

// ── monthly trend builder ──────────────────────────────────────────────────

type MonthRow = {
  ym: string;
  gross: number;
  fees: number;
  net: number;
};

type RawMonthlyPnl = PnlRow;
type RawMonthlyPhx = Awaited<ReturnType<typeof loadPhxDailyRows>>[number];

function buildMonthlyTrend(
  pnl: RawMonthlyPnl[],
  phx: RawMonthlyPhx[],
  feeRate: number,
): MonthRow[] {
  const months = new Map<
    string,
    { gross: number; phxRev: number; fees: number; refunds: number; alertEst: number }
  >();
  const get = (ym: string) => {
    let m = months.get(ym);
    if (!m) {
      m = { gross: 0, phxRev: 0, fees: 0, refunds: 0, alertEst: 0 };
      months.set(ym, m);
    }
    return m;
  };
  for (const r of pnl) {
    const ym = r.date.slice(0, 7);
    const m = get(ym);
    if (!PHX_STORE_IDS.has(r.store_id)) m.gross += num(r.revenue);
    m.fees += num(r.fees);
    m.refunds += num(r.refunds);
  }
  for (const r of phx) {
    const ym = (r.range_from ?? "").slice(0, 7);
    if (!ym) continue;
    const m = get(ym);
    const total =
      num(r.revenue_direct) +
      num(r.revenue_initial) +
      num(r.revenue_recurring) +
      num(r.revenue_salvage) +
      num(r.revenue_upsell);
    m.gross += total;
    m.phxRev += total;
  }
  const out: MonthRow[] = [];
  for (const [ym, m] of [...months.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const gateway = m.phxRev * feeRate;
    const fees = m.fees + gateway + m.refunds;
    out.push({ ym, gross: m.gross, fees, net: m.gross - fees });
  }
  return out;
}

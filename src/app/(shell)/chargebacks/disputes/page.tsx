// /chargebacks/disputes — only the alerts that actually count toward the
// processor's 1% chargeback ratio (alert_type containing DISPUTE or RDR).
// FRAUD alerts are pre-chargeback signals and are excluded here — they live
// on /chargebacks (the Alerts tab).

import { supabaseAdmin } from "@/lib/supabase/admin";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import { ChargebacksTimelineChart } from "@/components/chargebacks/TimelineChart";
import { ShieldAlert, Trophy, Gauge, Coins } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chargebacks · Disputes — CFO Agent" };

const RANGES = [
  { id: "7d", days: 7 },
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ratioTone(pct: number): "pos" | "warn" | "neg" {
  if (pct < 0.65) return "pos";
  if (pct < 0.85) return "warn";
  return "neg";
}

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function qs(p: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

type AlertRow = {
  id: string;
  card_brand: string | null;
  alert_type: string | null;
  amount: number | null;
  status: string | null;
  reason: string | null;
  order_id: string | null;
  customer_email: string | null;
  chargeblast_created_at: string | null;
  merchant_descriptor: string | null;
};

/** Alerts that actually represent real chargebacks (vs. pre-chargeback alerts
 *  like FRAUD/Ethoca/CDRN). The processor's 1% cap measures THESE. */
function isDispute(a: { alert_type: string | null }): boolean {
  const t = (a.alert_type ?? "").toUpperCase();
  return t.includes("DISPUTE") || t.includes("RDR");
}

async function loadDisputesInWindow(
  from: string,
  to: string,
): Promise<AlertRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("chargeblast_alerts")
    .select(
      "id, card_brand, alert_type, amount, status, reason, order_id, customer_email, chargeblast_created_at, merchant_descriptor",
    )
    .gte("chargeblast_created_at", `${from}T00:00:00Z`)
    .lte("chargeblast_created_at", `${to}T23:59:59Z`)
    .order("chargeblast_created_at", { ascending: false });
  if (error) return [];
  return ((data ?? []) as AlertRow[]).filter(isDispute);
}

async function loadOrdersInWindow(
  from: string,
  to: string,
): Promise<{ total: number; perDay: Map<string, number> }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("daily_pnl")
    .select("date, order_count")
    .gte("date", from)
    .lte("date", to);
  if (error || !data) return { total: 0, perDay: new Map() };
  const perDay = new Map<string, number>();
  let total = 0;
  for (const r of data as Array<{ date: string; order_count: number | null }>) {
    const c = Number(r.order_count ?? 0);
    total += c;
    perDay.set(r.date, (perDay.get(r.date) ?? 0) + c);
  }
  return { total, perDay };
}

function buildTimeline(
  from: string,
  to: string,
  disputes: AlertRow[],
  ordersByDay: Map<string, number>,
): Array<{ date: string; alerts: number; orders: number }> {
  const dayCounts = new Map<string, number>();
  for (const a of disputes) {
    if (!a.chargeblast_created_at) continue;
    const d = a.chargeblast_created_at.slice(0, 10);
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const days: Array<{ date: string; alerts: number; orders: number }> = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10);
    days.push({
      date: iso,
      alerts: dayCounts.get(iso) ?? 0,
      orders: ordersByDay.get(iso) ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export default async function ChargebacksDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);
  const range = RANGES.find((r) => r.id === params.range) ?? RANGES[1];

  const to = hasCustom ? customTo! : todayUtc();
  const from = hasCustom ? customFrom! : addDays(to, -(range.days - 1));
  const rangeLabel = hasCustom
    ? `${fmtDate(from)} → ${fmtDate(to)}`
    : `Last ${range.days} days`;

  const [disputes, tx] = await Promise.all([
    loadDisputesInWindow(from, to),
    loadOrdersInWindow(from, to),
  ]);
  const timeline = buildTimeline(from, to, disputes, tx.perDay);

  const total = disputes.length;
  const wonCount = disputes.filter((a) => a.status === "won").length;
  const lostCount = disputes.filter((a) => a.status === "lost").length;
  const pendingCount = disputes.filter((a) => a.status === "pending").length;
  const refundedCount = disputes.filter((a) => a.status === "refunded").length;
  const resolvedCount = wonCount + lostCount + refundedCount;
  const winRatePct = resolvedCount > 0 ? (wonCount / resolvedCount) * 100 : 0;

  const totalAmount = disputes.reduce((s, a) => s + Number(a.amount ?? 0), 0);
  const ratioPct = tx.total > 0 ? (total / tx.total) * 100 : 0;
  const ratioTone_ = ratioTone(ratioPct);

  // Per-type breakdown (DISPUTE_RDR / DISPUTE / anything else with RDR).
  const byType = new Map<string, { count: number; amount: number }>();
  for (const a of disputes) {
    const t = (a.alert_type ?? "(unknown)").toUpperCase();
    const cur = byType.get(t) ?? { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += Number(a.amount ?? 0);
    byType.set(t, cur);
  }
  const typeRows = [...byType.entries()]
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="dashboard-narrow">
      <div className="pnl-header" style={{ alignItems: "center" }}>
        <div>
          <div className="greet-eyebrow">Chargebacks · Disputes</div>
          <h1 className="greet-title">
            <ShieldAlert size={18} strokeWidth={2} /> {rangeLabel}
          </h1>
          <div className="section-sub" style={{ marginTop: 4 }}>
            Real chargebacks only — alert_type containing DISPUTE or RDR.
            These are the ones that count toward the processor&apos;s 1.0% cap.
          </div>
        </div>
        <div className="pnl-controls">
          <div className="seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/chargebacks/disputes${qs({ range: r.id })}`}
              >
                {r.id}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/chargebacks/disputes${qs({
                from: customFrom ?? from,
                to: customTo ?? to,
              })}`}
            >
              Custom
            </SegLink>
          </div>
          <DateRangeForm
            action="/chargebacks/disputes"
            from={customFrom ?? from}
            to={customTo ?? to}
          />
        </div>
      </div>

      {disputes.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
          No real chargebacks (DISPUTE / DISPUTE_RDR) in this window.
          {tx.total === 0
            ? " Also no transactions — try a wider range."
            : ` ${fmtInt(tx.total)} transactions processed; everything resolved before hitting the network.`}
        </div>
      ) : null}

      {/* ── KPI row ── */}
      <section>
        <div className="section-eyebrow">Chargeback signal</div>
        <div className="kpi-row">
          <KpiCard
            label="Total Chargebacks"
            value={fmtInt(total)}
            delta={null}
            deltaLabel={`${fmtInt(tx.total)} tx processed`}
            spark={[]}
            icon={<ShieldAlert size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label={`Won ${wonCount} · Lost ${lostCount} · Pending ${pendingCount}`}
            value={`${winRatePct.toFixed(1)}%`}
            delta={null}
            deltaLabel={`win rate (resolved ${fmtInt(resolvedCount)})`}
            spark={[]}
            icon={<Trophy size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Chargeback Ratio"
            value={`${ratioPct.toFixed(2)}%`}
            delta={null}
            deltaLabel={
              ratioTone_ === "pos"
                ? "healthy (< 0.65%)"
                : ratioTone_ === "warn"
                  ? "warning (0.65–0.85%)"
                  : "danger (> 0.85%)"
            }
            spark={[]}
            sparkColor={
              ratioTone_ === "pos"
                ? "var(--accent)"
                : ratioTone_ === "warn"
                  ? "var(--warning, #ffb020)"
                  : "var(--negative)"
            }
            icon={<Gauge size={14} strokeWidth={1.75} />}
          />
          <KpiCard
            label="Chargeback Cost"
            value={fmtMoney(totalAmount)}
            delta={null}
            deltaLabel={
              total > 0
                ? `avg ${fmtMoney(totalAmount / total)} per chargeback`
                : "—"
            }
            spark={[]}
            icon={<Coins size={14} strokeWidth={1.75} />}
          />
        </div>
      </section>

      {/* ── Per-type breakdown ── */}
      {typeRows.length > 0 ? (
        <section>
          <div className="section-eyebrow">Per-type breakdown</div>
          <div className="card table-card">
            <div className="table-wrap">
              <table className="pnl-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th className="num">Count</th>
                    <th className="num">Amount</th>
                    <th className="num">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {typeRows.map((r) => {
                    const pct = total > 0 ? (r.count / total) * 100 : 0;
                    return (
                      <tr key={r.type}>
                        <td>{r.type}</td>
                        <td className="num">{fmtInt(r.count)}</td>
                        <td className="num">{fmtMoney(r.amount)}</td>
                        <td className="num muted">{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="tfoot-row">
                    <td>Total</td>
                    <td className="num">{fmtInt(total)}</td>
                    <td className="num">{fmtMoney(totalAmount)}</td>
                    <td className="num">100.0%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Timeline chart ── */}
      {timeline.length > 0 ? (
        <section>
          <div className="section-eyebrow">Chargebacks over time</div>
          <div className="card" style={{ padding: 16 }}>
            <ChargebacksTimelineChart
              days={timeline}
              barLabel="Chargebacks / day"
              rateLabel="Chargeback ratio (7-day)"
              showThreshold
            />
          </div>
        </section>
      ) : null}

      {/* ── Granular row table ── */}
      {disputes.length > 0 ? (
        <section>
          <div className="section-eyebrow">All chargebacks</div>
          <div className="card table-card">
            <div className="table-wrap">
              <table className="pnl-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="mono">Alert ID</th>
                    <th>Type</th>
                    <th>Card</th>
                    <th className="num">Amount</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>Order / Customer</th>
                  </tr>
                </thead>
                <tbody>
                  {disputes.map((a) => {
                    const dt = a.chargeblast_created_at
                      ? new Date(a.chargeblast_created_at)
                      : null;
                    const statusColor =
                      a.status === "won"
                        ? "var(--accent)"
                        : a.status === "lost"
                          ? "var(--negative)"
                          : "var(--muted-strong)";
                    return (
                      <tr key={a.id}>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {dt
                            ? `${dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${dt.toISOString().slice(11, 16)}Z`
                            : "—"}
                        </td>
                        <td
                          className="mono muted"
                          style={{
                            fontSize: 10.5,
                            maxWidth: 110,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.id}
                        </td>
                        <td>{a.alert_type}</td>
                        <td className="muted">
                          {(a.card_brand ?? "").toUpperCase()}
                        </td>
                        <td className="num">
                          {fmtMoney(Number(a.amount ?? 0))}
                        </td>
                        <td
                          className="muted"
                          style={{
                            maxWidth: 200,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.reason}
                        </td>
                        <td style={{ color: statusColor, fontWeight: 600 }}>
                          {a.status}
                        </td>
                        <td
                          className="muted"
                          style={{
                            fontSize: 11,
                            maxWidth: 200,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.order_id ?? a.customer_email ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

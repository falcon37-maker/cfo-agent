import { supabaseAdmin } from "@/lib/supabase/admin";
import { fmtDate, fmtMoney, fmtInt } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { SegLink } from "@/components/pnl/SegLink";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";
import { ChargebacksTimelineChart } from "@/components/chargebacks/TimelineChart";
import { ShieldAlert, Trophy, Gauge, Coins } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chargebacks — CFO Agent" };

const RANGES = [
  { id: "7d", days: 7 },
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Processor-watched thresholds. Green < 0.65% ; Yellow < 0.85% ; Red ≥.
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

type AlertRow = {
  id: string;
  store_id: string | null;
  card_brand: string | null;
  alert_type: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  reason: string | null;
  order_id: string | null;
  customer_email: string | null;
  chargeblast_created_at: string | null;
  merchant_descriptor: string | null;
};

async function loadAlertsInWindow(
  from: string,
  to: string,
): Promise<AlertRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("chargeblast_alerts")
    .select(
      "id, store_id, card_brand, alert_type, amount, currency, status, reason, order_id, customer_email, chargeblast_created_at, merchant_descriptor",
    )
    .gte("chargeblast_created_at", `${from}T00:00:00Z`)
    .lte("chargeblast_created_at", `${to}T23:59:59Z`)
    .order("chargeblast_created_at", { ascending: false });
  if (error) {
    // Table may not exist yet if migration 009 hasn't been applied.
    return [];
  }
  return (data ?? []) as AlertRow[];
}

async function loadTransactionsInWindow(
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
  alerts: AlertRow[],
  orderCountByDay: Map<string, number>,
): Array<{ date: string; alerts: number; orders: number }> {
  const alertsByDay = new Map<string, number>();
  for (const a of alerts) {
    if (!a.chargeblast_created_at) continue;
    const date = a.chargeblast_created_at.slice(0, 10);
    alertsByDay.set(date, (alertsByDay.get(date) ?? 0) + 1);
  }
  const days: Array<{ date: string; alerts: number; orders: number }> = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10);
    days.push({
      date: iso,
      alerts: alertsByDay.get(iso) ?? 0,
      orders: orderCountByDay.get(iso) ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export default async function ChargebacksPage({
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

  const [alerts, tx] = await Promise.all([
    loadAlertsInWindow(from, to),
    loadTransactionsInWindow(from, to),
  ]);
  const txTotal = tx.total;
  const timeline = buildTimeline(from, to, alerts, tx.perDay);

  const totalAlerts = alerts.length;
  const wonCount = alerts.filter((a) => a.status === "won").length;
  const lostCount = alerts.filter((a) => a.status === "lost").length;
  const pendingCount = alerts.filter((a) => a.status === "pending").length;
  const refundedCount = alerts.filter((a) => a.status === "refunded").length;
  const resolvedCount = wonCount + lostCount + refundedCount;
  const winRatePct =
    resolvedCount > 0 ? (wonCount / resolvedCount) * 100 : 0;

  const alertAmount = alerts.reduce((s, a) => s + Number(a.amount ?? 0), 0);
  const avgPerAlert = totalAlerts > 0 ? alertAmount / totalAlerts : 0;

  // All stores share a single Chargeblast merchant descriptor today, so the
  // denominator is portfolio-wide transaction count.
  const ratioPct = txTotal > 0 ? (totalAlerts / txTotal) * 100 : 0;
  const ratioTone_ = ratioTone(ratioPct);

  function qs(p: Record<string, string>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `?${s}` : "";
  }

  return (
    <div className="dashboard-narrow">
      <div className="pnl-header" style={{ alignItems: "center" }}>
        <div>
          <div className="greet-eyebrow">Chargebacks</div>
          <h1 className="greet-title">
            <ShieldAlert size={18} strokeWidth={2} /> {rangeLabel}
          </h1>
          <div className="section-sub" style={{ marginTop: 4 }}>
            Alerts from Chargeblast (Ethoca / CDRN). Processor cap is 1.0% —
            stay below 0.65% for green.
          </div>
        </div>
        <div className="pnl-controls">
          <div className="seg" role="tablist" aria-label="Range">
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/chargebacks${qs({ range: r.id })}`}
              >
                {r.id}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/chargebacks${qs({
                from: customFrom ?? from,
                to: customTo ?? to,
              })}`}
            >
              Custom
            </SegLink>
          </div>
          <DateRangeForm
            action="/chargebacks"
            from={customFrom ?? from}
            to={customTo ?? to}
          />
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
          No Chargeblast alerts in this window.
          {" "}
          {txTotal === 0
            ? "Also no transactions — try a wider range."
            : `${fmtInt(txTotal)} transactions processed.`}
          <div style={{ marginTop: 10, fontSize: 11.5 }}>
            If you&apos;ve just connected Chargeblast, trigger a manual sync at{" "}
            <code className="mono">/api/sync/chargeblast?action=backfill</code>.
          </div>
        </div>
      ) : null}

      {/* ── KPI row ── */}
      <section>
        <div className="section-eyebrow">Chargeback signal</div>
        <div className="kpi-row">
          <KpiCard
            label="Total Alerts"
            value={fmtInt(totalAlerts)}
            delta={null}
            deltaLabel={`${fmtInt(txTotal)} tx processed`}
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
            label="Alert Cost"
            value={fmtMoney(alertAmount)}
            delta={null}
            deltaLabel={`avg ${fmtMoney(avgPerAlert)} per alert`}
            spark={[]}
            icon={<Coins size={14} strokeWidth={1.75} />}
          />
        </div>
      </section>

      {/* ── Timeline chart ── */}
      {timeline.length > 0 ? (
        <section>
          <div className="section-eyebrow">Alerts over time</div>
          <div className="card" style={{ padding: 16 }}>
            <ChargebacksTimelineChart days={timeline} />
          </div>
        </section>
      ) : null}

      {/* ── Recent alerts feed ── */}
      {alerts.length > 0 ? (
        <section>
          <div className="section-eyebrow">Recent alerts</div>
          <div className="card table-card">
            <div className="table-wrap">
              <table className="pnl-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Card</th>
                    <th>Type</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.slice(0, 20).map((a) => {
                    const statusColor =
                      a.status === "won"
                        ? "var(--accent)"
                        : a.status === "lost"
                          ? "var(--negative)"
                          : "var(--muted-strong)";
                    const dt = a.chargeblast_created_at
                      ? new Date(a.chargeblast_created_at)
                      : null;
                    return (
                      <tr key={a.id}>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {dt
                            ? `${dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${dt.toISOString().slice(11, 16)}Z`
                            : "—"}
                        </td>
                        <td className="muted">{(a.card_brand ?? "").toUpperCase()}</td>
                        <td className="muted">{a.alert_type}</td>
                        <td className="num">{fmtMoney(Number(a.amount ?? 0))}</td>
                        <td style={{ color: statusColor, fontWeight: 600 }}>
                          {a.status}
                        </td>
                        <td
                          className="muted"
                          style={{
                            maxWidth: 280,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.reason}
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

import Link from "next/link";
import { Users, UserMinus, UserX, Target, CreditCard } from "lucide-react";
import {
  loadLatestPortfolioSnapshot,
  loadPortfolioSnapshots,
  type PhxSnapshot,
} from "@/lib/phx/queries";
import { fmtDate, fmtInt, fmtMoney, fmtPct } from "@/lib/format";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { DateRangeForm } from "@/components/pnl/DateRangeForm";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function qs(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);

  const [snapshot, history] = await Promise.all([
    loadLatestPortfolioSnapshot(
      hasCustom ? { from: customFrom!, to: customTo! } : undefined,
    ),
    loadPortfolioSnapshots(12),
  ]);

  return (
    <>
      <div className="pnl-header">
        <div>
          <h2 className="section-title">
            Subscriptions
            <span className="phx-tag">PHX</span>
          </h2>
          <div className="section-sub">
            Portfolio · all Falcon 37 stores aggregated ·{" "}
            {snapshot
              ? `period ${fmtDate(snapshot.range_from!)} → ${fmtDate(snapshot.range_to!)} · scraped ${relTime(snapshot.scraped_at)}`
              : hasCustom
                ? "no snapshot in this range"
                : "no snapshots yet — sync via the Chrome extension"}
          </div>
        </div>
        <div className="pnl-controls">
          <DateRangeForm
            action="/subscriptions"
            from={customFrom}
            to={customTo}
          />
        </div>
      </div>

      {snapshot == null ? (
        <EmptyState />
      ) : (
        <>
          <section className="kpi-row kpi-5">
            <KpiCard
              label="Active Subscribers"
              value={fmtInt(snapshot.active_subscribers)}
              delta={null}
              spark={[]}
              icon={<Users size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="In Salvage"
              value={fmtInt(snapshot.subscribers_in_salvage)}
              delta={null}
              spark={[]}
              icon={<UserMinus size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Cancelled (lifetime)"
              value={fmtInt(snapshot.cancelled_subscribers)}
              delta={null}
              spark={[]}
              icon={<UserX size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Target CAC"
              value={
                snapshot.target_cac != null
                  ? fmtMoney(snapshot.target_cac)
                  : "—"
              }
              delta={null}
              spark={[]}
              icon={<Target size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Subs to bill"
              value={fmtInt(snapshot.subscriptions_to_bill)}
              delta={null}
              spark={[]}
              icon={<CreditCard size={14} strokeWidth={1.75} />}
            />
          </section>

          <OrderMix snapshot={snapshot} />
          <RefundSummary snapshot={snapshot} />
          {history.length > 1 ? <PeriodHistory snapshots={history} /> : null}
          <WaveBStub />
        </>
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div
      className="card"
      style={{
        padding: "32px",
        textAlign: "center",
        color: "var(--text-dim)",
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>
        No Phoenix data yet
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          marginTop: 8,
          maxWidth: 520,
          marginInline: "auto",
        }}
      >
        Install the{" "}
        <Link
          href="https://github.com/falcon37-maker/cfo-agent-extension"
          style={{ color: "var(--accent)" }}
          target="_blank"
        >
          CFO Agent PHX Sync
        </Link>{" "}
        Chrome extension, open{" "}
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            background: "var(--surface-3)",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          app1.phoenixcrm.io/app/dashboard
        </code>
        , set a Date Range, and hit Sync Now. Portfolio-level aggregates land
        in <code>phx_summary_snapshots</code>.
      </div>
    </div>
  );
}

function OrderMix({ snapshot }: { snapshot: PhxSnapshot }) {
  const rows = [
    {
      label: "Direct Sale",
      count: snapshot.direct_sale_count,
      pct: snapshot.direct_sale_success_pct,
    },
    {
      label: "Initial Subscription",
      count: snapshot.initial_subscription_count,
      pct: snapshot.initial_subscription_success_pct,
    },
    {
      label: "Recurring Subscription",
      count: snapshot.recurring_subscription_count,
      pct: snapshot.recurring_subscription_success_pct,
    },
    {
      label: "Subscription Salvage",
      count: snapshot.subscription_salvage_count,
      pct: snapshot.subscription_salvage_success_pct,
    },
    {
      label: "Upsell",
      count: snapshot.upsell_count,
      pct: snapshot.upsell_success_pct,
    },
  ];

  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Order mix</div>
          <div className="card-sub">
            Counts and approval rates over the PHX-selected date range
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Count</th>
              <th className="num">Approval %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{fmtInt(r.count)}</td>
                <td className="num muted">
                  {r.pct != null ? fmtPct(r.pct) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RefundSummary({ snapshot }: { snapshot: PhxSnapshot }) {
  const byChannel: Array<[string, number | null]> = [
    ["Agent", snapshot.refund_agent],
    ["Ethoca", snapshot.refund_ethoca],
    ["CDRN", snapshot.refund_cdrn],
    ["RDR withdrawals", snapshot.refund_rdr_withdrawals],
    ["Chargeback withdrawals", snapshot.refund_chargeback_withdrawals],
  ];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Refunds & chargebacks</div>
          <div className="card-sub">Month-to-date + channel breakdown</div>
        </div>
      </div>
      <div style={{ padding: "16px 18px", display: "grid", gap: 18 }}>
        <div className="pnl-totals" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <div className="total-tile">
            <div className="total-label">Refunds MTD</div>
            <div className="total-value">{fmtInt(snapshot.refunds_mtd_count)}</div>
            <div className="card-sub">
              {snapshot.refunds_mtd_pct != null
                ? `${fmtPct(snapshot.refunds_mtd_pct)} of ${fmtInt(snapshot.total_transactions_mtd)} txns`
                : "—"}
            </div>
          </div>
          <div className="total-tile">
            <div className="total-label">Chargebacks MTD</div>
            <div className="total-value">{fmtInt(snapshot.chargebacks_mtd_count)}</div>
            <div className="card-sub">
              {snapshot.chargebacks_mtd_pct != null
                ? fmtPct(snapshot.chargebacks_mtd_pct)
                : "—"}
            </div>
          </div>
          <div className="total-tile">
            <div className="total-label">Refund $ total</div>
            <div className="total-value">{fmtMoney(snapshot.refund_total)}</div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {byChannel.map(([label, val]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num muted">
                    {val != null ? fmtMoney(val) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PeriodHistory({ snapshots }: { snapshots: PhxSnapshot[] }) {
  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Snapshot history</div>
          <div className="card-sub">
            One row per PHX reporting period, newest first
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Period</th>
              <th className="num">Active</th>
              <th className="num">Salvage</th>
              <th className="num">Cancelled</th>
              <th className="num">Txns</th>
              <th className="num">Refund $</th>
              <th className="num">Scraped</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={`${s.range_from}-${s.range_to}`}>
                <td>
                  {fmtDate(s.range_from!)} → {fmtDate(s.range_to!)}
                </td>
                <td className="num">{fmtInt(s.active_subscribers)}</td>
                <td className="num muted">{fmtInt(s.subscribers_in_salvage)}</td>
                <td className="num muted">{fmtInt(s.cancelled_subscribers)}</td>
                <td className="num muted">{fmtInt(s.total_transactions_mtd)}</td>
                <td className="num muted">{fmtMoney(s.refund_total)}</td>
                <td className="num muted">{relTime(s.scraped_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WaveBStub() {
  return (
    <div
      className="card"
      style={{ padding: 18, color: "var(--muted)", fontSize: 12 }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: 6,
        }}
      >
        Coming in Wave B
      </div>
      <div style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
        Retention curve, cohort heatmap, new-vs-cancelled flow, and LTV/CAC
        require per-subscriber data from the PHX customer list page. Those
        parsers ship once we grab inspect screenshots of the PHX subscribers
        and rebill transactions pages.
      </div>
    </div>
  );
}

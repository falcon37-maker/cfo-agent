import Link from "next/link";
import {
  Users,
  CreditCard,
  Target,
  Activity,
  AlertCircle,
} from "lucide-react";
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

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function pct(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function periodLabel(s: PhxSnapshot): string {
  const from = new Date(`${s.range_from}T00:00:00Z`);
  const to = new Date(`${s.range_to}T00:00:00Z`);
  // If it's a full calendar month → "April 2026"; otherwise "Apr 1 → Apr 20"
  const sameMonth =
    from.getUTCFullYear() === to.getUTCFullYear() &&
    from.getUTCMonth() === to.getUTCMonth();
  const firstDay = from.getUTCDate() === 1;
  const lastDay =
    new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate() ===
    to.getUTCDate();
  if (sameMonth && firstDay && lastDay) {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(from);
  }
  return `${fmtDate(s.range_from!)} → ${fmtDate(s.range_to!)}`;
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

  // Oldest-first series for sparklines.
  const chrono = [...history].reverse();
  const chronoIdx = snapshot
    ? chrono.findIndex(
        (s) =>
          s.range_from === snapshot.range_from &&
          s.range_to === snapshot.range_to,
      )
    : -1;
  const prior = chronoIdx > 0 ? chrono[chronoIdx - 1] : null;

  const trend = (k: keyof PhxSnapshot): number[] =>
    chrono.map((s) => Number(s[k] ?? 0));

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
              ? `${periodLabel(snapshot)} · scraped ${relTime(snapshot.scraped_at)}`
              : hasCustom
                ? "no snapshot matches this range"
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
        <EmptyState hasCustom={hasCustom} />
      ) : (
        <>
          <section className="kpi-row kpi-5">
            <KpiCard
              label="Active Subscribers"
              value={fmtInt(snapshot.active_subscribers)}
              delta={null}
              deltaLabel="lifetime · as of scrape"
              spark={trend("active_subscribers")}
              icon={<Users size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Subs to bill"
              value={fmtInt(snapshot.subscriptions_to_bill)}
              delta={pct(
                snapshot.subscriptions_to_bill,
                prior?.subscriptions_to_bill ?? null,
              )}
              deltaLabel={prior ? `vs ${periodLabel(prior)}` : "no prior period"}
              spark={trend("subscriptions_to_bill")}
              icon={<CreditCard size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Target CAC"
              value={
                snapshot.target_cac != null
                  ? fmtMoney(snapshot.target_cac)
                  : "—"
              }
              delta={pct(snapshot.target_cac, prior?.target_cac ?? null)}
              deltaLabel={prior ? `vs ${periodLabel(prior)}` : "no prior period"}
              spark={trend("target_cac")}
              sparkColor="var(--muted-strong)"
              invert
              icon={<Target size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Transactions"
              value={fmtInt(snapshot.total_transactions_mtd)}
              delta={pct(
                snapshot.total_transactions_mtd,
                prior?.total_transactions_mtd ?? null,
              )}
              deltaLabel={prior ? `vs ${periodLabel(prior)}` : "no prior period"}
              spark={trend("total_transactions_mtd")}
              icon={<Activity size={14} strokeWidth={1.75} />}
            />
            <KpiCard
              label="Refund total"
              value={fmtMoney(snapshot.refund_total)}
              delta={pct(snapshot.refund_total, prior?.refund_total ?? null)}
              deltaLabel={prior ? `vs ${periodLabel(prior)}` : "no prior period"}
              spark={trend("refund_total")}
              sparkColor="var(--negative)"
              invert
              icon={<AlertCircle size={14} strokeWidth={1.75} />}
            />
          </section>

          <LifetimeNote snapshot={snapshot} />

          <OrderMix snapshot={snapshot} />
          <RefundSummary snapshot={snapshot} />
          {history.length > 1 ? (
            <PeriodHistory snapshots={history} current={snapshot} />
          ) : null}
          <WaveBStub />
        </>
      )}
    </>
  );
}

/** Small callout below the KPI row explaining the lifetime vs period split. */
function LifetimeNote({ snapshot }: { snapshot: PhxSnapshot }) {
  return (
    <div
      className="card"
      style={{
        padding: "12px 18px",
        display: "flex",
        gap: 24,
        flexWrap: "wrap",
        alignItems: "center",
        fontSize: 12,
        color: "var(--muted)",
      }}
    >
      <span
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: 10.5,
          fontWeight: 500,
        }}
      >
        Lifetime · as of scrape
      </span>
      <span>
        Active <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{fmtInt(snapshot.active_subscribers)}</strong>
      </span>
      <span>
        In salvage{" "}
        <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{fmtInt(snapshot.subscribers_in_salvage)}</strong>
      </span>
      <span>
        Cancelled{" "}
        <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{fmtInt(snapshot.cancelled_subscribers)}</strong>
      </span>
      <span style={{ marginLeft: "auto", fontStyle: "italic" }}>
        These are store-state counters; they don&apos;t change with the PHX date range.
      </span>
    </div>
  );
}

function EmptyState({ hasCustom }: { hasCustom: boolean }) {
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
        {hasCustom ? "No snapshot in this range" : "No Phoenix data yet"}
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
        {hasCustom ? (
          <>
            Try a wider date range, or{" "}
            <Link href="/subscriptions" style={{ color: "var(--accent)" }}>
              clear the filter
            </Link>{" "}
            to see the most recent snapshot.
          </>
        ) : (
          <>
            Install the{" "}
            <Link
              href="https://github.com/falcon37-maker/cfo-agent-extension"
              style={{ color: "var(--accent)" }}
              target="_blank"
            >
              CFO Agent PHX Sync
            </Link>{" "}
            extension, open{" "}
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
            , set a Date Range, and hit Sync Now.
          </>
        )}
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
  const total = rows.reduce((s, r) => s + (r.count ?? 0), 0);

  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Order mix</div>
          <div className="card-sub">
            Counts and approval rates for {periodLabel(snapshot)}
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Count</th>
              <th className="num">% of mix</th>
              <th className="num">Approval %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const share = total > 0 ? ((r.count ?? 0) / total) * 100 : 0;
              return (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{fmtInt(r.count)}</td>
                  <td className="num muted">
                    {share > 0 ? fmtPct(share) : "—"}
                  </td>
                  <td className="num muted">
                    {r.pct != null ? fmtPct(r.pct) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="tfoot-row">
              <td>Total</td>
              <td className="num">{fmtInt(total)}</td>
              <td className="num">100.0%</td>
              <td className="num">—</td>
            </tr>
          </tfoot>
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
          <div className="card-title">Refunds &amp; chargebacks</div>
          <div className="card-sub">Month-to-date + channel breakdown</div>
        </div>
      </div>
      <div style={{ padding: "16px 18px", display: "grid", gap: 18 }}>
        <div
          className="pnl-totals"
          style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
        >
          <div className="total-tile">
            <div className="total-label">Refunds MTD</div>
            <div className="total-value">
              {fmtInt(snapshot.refunds_mtd_count)}
            </div>
            <div className="card-sub">
              {snapshot.refunds_mtd_pct != null
                ? `${fmtPct(snapshot.refunds_mtd_pct)} of ${fmtInt(snapshot.total_transactions_mtd)} txns`
                : "—"}
            </div>
          </div>
          <div className="total-tile">
            <div className="total-label">Chargebacks MTD</div>
            <div className="total-value">
              {fmtInt(snapshot.chargebacks_mtd_count)}
            </div>
            <div className="card-sub">
              {snapshot.chargebacks_mtd_pct != null
                ? fmtPct(snapshot.chargebacks_mtd_pct)
                : "—"}
            </div>
          </div>
          <div className="total-tile tone-neg">
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

function PeriodHistory({
  snapshots,
  current,
}: {
  snapshots: PhxSnapshot[];
  current: PhxSnapshot;
}) {
  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Snapshot history</div>
          <div className="card-sub">
            One row per PHX reporting period · {snapshots.length} captured
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Period</th>
              <th className="num">Transactions</th>
              <th className="num">Direct</th>
              <th className="num">Rebills</th>
              <th className="num">CAC</th>
              <th className="num">Refund $</th>
              <th className="num">Scraped</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => {
              const isCurrent =
                s.range_from === current.range_from &&
                s.range_to === current.range_to;
              return (
                <tr
                  key={`${s.range_from}-${s.range_to}`}
                  style={
                    isCurrent
                      ? { background: "var(--accent-bg)" }
                      : undefined
                  }
                >
                  <td>
                    <Link
                      href={`/subscriptions?from=${s.range_from}&to=${s.range_to}`}
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      {periodLabel(s)}
                    </Link>
                    {isCurrent ? (
                      <span
                        className="phx-tag"
                        style={{
                          marginLeft: 8,
                          fontSize: 9,
                          padding: "2px 5px",
                          background: "var(--accent-bg-strong)",
                        }}
                      >
                        VIEWING
                      </span>
                    ) : null}
                  </td>
                  <td className="num">{fmtInt(s.total_transactions_mtd)}</td>
                  <td className="num muted">{fmtInt(s.direct_sale_count)}</td>
                  <td className="num muted">
                    {fmtInt(s.recurring_subscription_count)}
                  </td>
                  <td className="num muted">
                    {s.target_cac != null ? fmtMoney(s.target_cac) : "—"}
                  </td>
                  <td className="num muted">{fmtMoney(s.refund_total)}</td>
                  <td className="num muted">{relTime(s.scraped_at)}</td>
                </tr>
              );
            })}
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
        Retention curve, cohort heatmap, and LTV/CAC require per-subscriber
        data from the PHX customer list page. Those parsers ship once we grab
        inspect screenshots of the PHX subscribers and rebill transactions
        pages.
      </div>
    </div>
  );
}

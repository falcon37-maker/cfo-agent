"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BlendedDailyRow } from "@/lib/pnl/queries";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";
import { TableFooter } from "@/components/subscriptions/TableFooter";
import { ExportCsvButton } from "@/components/subscriptions/ExportCsvButton";
import { useSubsSearch } from "@/components/subscriptions/SubsTableSearch";
// Processing-fee rates (client spec Jun 2026):
//   drop-ship Shopify stores  → 3.9% of their store revenue
//   subscription (PHX) stores → 16.3% of their total (checkout + subs billed)
// Imported so this column can never drift from the rates the P&L layer nets out.
import { DROPSHIP_FEE_RATE, SUBS_FEE_RATE } from "@/lib/pnl/fees";

const PAGE_SIZES = [10, 25, 50, 100];

type Props = {
  rows: BlendedDailyRow[];
  /** Range pills etc — rendered in the card head's right side. */
  rangeControl?: React.ReactNode;
  /** Show a Fees column. Net Profit nets out exactly this fee — every row
   *  foots as Total − COGS − Fees − Ad Spend = Net Profit. */
  showFees?: boolean;
  /** When set, renders a Transactions-style footer bar (row count + range
   *  label + Export to CSV + page indicator) below the table. Omit to keep
   *  the bare table (e.g. on the dashboard). */
  csvFilename?: string;
  /** Context label shown in the footer, e.g. the active range. */
  footerLabel?: string;
  /** Turn on the Transactions-style interactive toolbar: a per-table search
   *  box + rows-per-page selector + numbered pagination. Purely front-end —
   *  it filters/pages only the rows already passed in; no data is re-fetched.
   *  Off by default so the dashboard table stays static. */
  searchable?: boolean;
};

/** Per-row processing fee: drop-ship (non-PHX) Shopify revenue at 3.9%, PHX
 *  revenue (their checkout + billed subscriptions) at 16.3%. This mirrors
 *  loadBlendedDashboardData's net-profit maths exactly — there used to be a
 *  second "whole Total × one rate" mode for the Subscriptions page, which fee'd
 *  manual revenue the P&L layer never charged. Manual revenue carries no
 *  processor fee (it isn't card-processed), so it's excluded here too. */
function rowFee(r: BlendedDailyRow): number {
  const phxRevenue =
    r.phx_frontend_revenue + r.phx_subs_revenue + r.phx_upsell_revenue;
  return r.shopify_revenue * DROPSHIP_FEE_RATE + phxRevenue * SUBS_FEE_RATE;
}

/** Front-end revenue for a row (PHX Direct+Initial + non-PHX Shopify + upsell).
 *  Kept here so both the cell and the search/CSV helpers agree. */
function frontendRevenue(r: BlendedDailyRow): number {
  return r.phx_frontend_revenue + r.shopify_revenue + r.phx_upsell_revenue;
}

/**
 * Blended daily P&L — Shopify front-end + PHX recurring side-by-side,
 * with a Total column, Net Profit pill, and a totals + averages footer.
 */
export function BlendedPnlTable({
  rows,
  rangeControl,
  showFees = false,
  csvFilename,
  footerLabel,
  searchable = false,
}: Props) {
  // Total fees = sum of each row's fee (handles the split rates correctly).
  const totalFees = rows.reduce((s, r) => s + rowFee(r), 0);
  // Show newest day first (day-wise descending) regardless of how the data
  // layer ordered the array. Totals are order-independent (a sum).
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.date.localeCompare(a.date)),
    [rows],
  );
  const totals = rows.reduce(
    (acc, r) => {
      acc.orders += r.shopify_orders;
      acc.new_subs += r.new_subs;
      acc.upsell += r.upsell_orders;
      acc.subs += r.phx_subs_billed;
      // Frontend = PHX Direct + Initial (acquisition), plus revenue from any
      // store NOT on PHX (which still flows through shopify_revenue).
      // Upsell folds into Frontend so TOTAL REV = FRONTEND REV + SUBS REV
      // exactly. Today phx_upsell_revenue is always 0 in our data; when it
      // does land it's an at-checkout add-on, which lives with acquisition.
      acc.frontend_rev +=
        r.phx_frontend_revenue + r.shopify_revenue + r.phx_upsell_revenue;
      acc.subs_rev += r.phx_subs_revenue;
      acc.manual_rev += r.manual_revenue;
      acc.total_rev += r.total_revenue;
      acc.ad_spend += r.shopify_ad_spend;
      acc.cogs += r.shopify_cogs;
      acc.net_profit += r.total_net_profit;
      return acc;
    },
    {
      orders: 0,
      new_subs: 0,
      upsell: 0,
      subs: 0,
      frontend_rev: 0,
      subs_rev: 0,
      manual_rev: 0,
      total_rev: 0,
      ad_spend: 0,
      cogs: 0,
      net_profit: 0,
    },
  );
  const totalRoas = totals.ad_spend > 0 ? totals.total_rev / totals.ad_spend : 0;
  // Show MANUAL REV column only when this tenant has logged any. Keeps the
  // table tight for ecom-only users.
  const showManual = totals.manual_rev > 0;
  const colSpan = 10 + (showManual ? 1 : 0) + (showFees ? 1 : 0);

  // ── Interactive view state (only used when `searchable`) ──────────────
  // The query is shared via context so the search box can live up in the
  // page filter bar while this table consumes it. Safe on the dashboard
  // (no provider → query is always "").
  const { query } = useSubsSearch();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  // Reset to the first page whenever the search query changes. Done during
  // render with a previous-value guard (the React-recommended alternative to
  // a setState-in-effect) so it stays in sync without cascading renders.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setPage(1);
  }

  // Filter the already-rendered rows by a free-text match over their visible
  // values. No data is re-fetched — this is a pure front-end convenience.
  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return sortedRows;
    const q = query.toLowerCase();
    return sortedRows.filter((r) => {
      const hay = [
        fmtDate(r.date),
        r.shopify_orders,
        r.phx_subs_billed,
        fmtMoney(frontendRevenue(r)),
        fmtMoney(r.phx_subs_revenue),
        fmtMoney(r.total_revenue),
        fmtMoney(r.shopify_cogs),
        fmtMoney(r.shopify_ad_spend),
        fmtMoney(r.total_net_profit),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [searchable, query, sortedRows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const sliceStart = (safePage - 1) * pageSize;
  const displayRows = searchable
    ? filtered.slice(sliceStart, sliceStart + pageSize)
    : sortedRows;
  const showingFrom = filtered.length === 0 ? 0 : sliceStart + 1;
  const showingTo = Math.min(sliceStart + pageSize, filtered.length);

  // CSV mirrors the visible table columns; exports the current filter result.
  const csvHeaders = [
    "Date",
    "Shopify Orders",
    "Subs Billed",
    "Shopify Revenue",
    "Subscription Revenue",
    ...(showManual ? ["Manual Rev"] : []),
    "Total",
    "COGS",
    ...(showFees ? ["Fees"] : []),
    "Ad Spend",
    "ROAS",
    "Net Profit",
  ];
  const toCsvRow = (r: BlendedDailyRow): Array<string | number> => {
    const roas =
      r.shopify_ad_spend > 0 ? r.total_revenue / r.shopify_ad_spend : 0;
    return [
      fmtDate(r.date),
      fmtInt(r.shopify_orders),
      r.phx_subs_billed > 0 ? fmtInt(r.phx_subs_billed) : "—",
      frontendRevenue(r) > 0 ? fmtMoney(frontendRevenue(r)) : "—",
      r.phx_subs_revenue > 0 ? fmtMoney(r.phx_subs_revenue) : "—",
      ...(showManual
        ? [r.manual_revenue > 0 ? fmtMoney(r.manual_revenue) : "—"]
        : []),
      fmtMoney(r.total_revenue),
      fmtMoney(r.shopify_cogs),
      ...(showFees
        ? [r.total_revenue > 0 ? fmtMoney(rowFee(r)) : "—"]
        : []),
      fmtMoney(r.shopify_ad_spend),
      r.shopify_ad_spend > 0 ? `${roas.toFixed(2)}x` : "—",
      fmtMoney(r.total_net_profit),
    ];
  };
  const csvRows = (searchable ? filtered : sortedRows).map(toCsvRow);

  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Daily P&amp;L · blended</div>
          <div className="card-sub">
            Shopify store revenue + subscription billing per day —
            Total = Shopify Revenue + Subscription Revenue (+ manual)
          </div>
        </div>
        {rangeControl ? (
          <div className="card-actions">{rangeControl}</div>
        ) : null}
      </div>

        <div className="table-wrap">
          <table
            className={`pnl-table pnl-sticky-first${searchable ? " pnl-table-wide" : ""}`}
          >
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">New Subs</th>
                <th className="num">Upsell</th>
                <th className="num">Subs Billed</th>
                <th className="num">Shopify Revenue</th>
                <th className="num">Subscription Revenue</th>
                {showManual ? <th className="num">Manual Rev</th> : null}
                <th className="num">Total</th>
                <th className="num">COGS</th>
                {showFees ? <th className="num">Fees</th> : null}
                <th className="num">Ad Spend</th>
                <th className="num">ROAS</th>
                <th className="num">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r) => {
                const roas =
                  r.shopify_ad_spend > 0 ? r.total_revenue / r.shopify_ad_spend : 0;
                const strongRoas = roas >= 3.0;
                const profitable = r.total_net_profit >= 0;
                // Frontend Rev = PHX Direct + Initial (Vip Initial), plus
                // any non-PHX store's Shopify revenue, plus PHX upsell — keeps
                // TOTAL = FRONTEND + SUBS exact.
                const frontendRev = frontendRevenue(r);
                return (
                  <tr key={r.date}>
                    <td>{fmtDate(r.date)}</td>
                    <td className="num muted">{fmtInt(r.new_subs)}</td>
                    <td className="num muted">
                      {r.upsell_orders > 0 ? fmtInt(r.upsell_orders) : "—"}
                    </td>
                    <td className="num muted">
                      {r.phx_subs_billed > 0 ? fmtInt(r.phx_subs_billed) : "—"}
                    </td>
                    <td className="num">
                      {frontendRev > 0 ? fmtMoney(frontendRev) : "—"}
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--accent-dim)" }}
                    >
                      {r.phx_subs_revenue > 0
                        ? fmtMoney(r.phx_subs_revenue)
                        : "—"}
                    </td>
                    {showManual ? (
                      <td className="num muted">
                        {r.manual_revenue > 0
                          ? fmtMoney(r.manual_revenue)
                          : "—"}
                      </td>
                    ) : null}
                    <td className="num" style={{ fontWeight: 550 }}>
                      {fmtMoney(r.total_revenue)}
                    </td>
                    <td className="num muted">{fmtMoney(r.shopify_cogs)}</td>
                    {showFees ? (
                      <td className="num muted">
                        {r.total_revenue > 0
                          ? fmtMoney(rowFee(r))
                          : "—"}
                      </td>
                    ) : null}
                    <td className="num muted">{fmtMoney(r.shopify_ad_spend)}</td>
                    <td
                      className={`num roas ${
                        r.shopify_ad_spend > 0
                          ? strongRoas
                            ? "pos"
                            : "neg"
                          : ""
                      }`}
                    >
                      {r.shopify_ad_spend > 0 ? `${roas.toFixed(2)}x` : "—"}
                    </td>
                    <td className={`num profit ${profitable ? "pos" : "neg"}`}>
                      <span className="profit-pill">
                        {searchable ? <span className="pill-dot" /> : null}
                        {fmtMoney(r.total_net_profit)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {searchable && displayRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={colSpan}
                    style={{
                      textAlign: "center",
                      padding: 28,
                      color: "var(--muted)",
                    }}
                  >
                    No rows match “{query}”.
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="tfoot-row">
                <td>TOTAL</td>
                <td className="num">{fmtInt(totals.new_subs)}</td>
                <td className="num">
                  {totals.upsell > 0 ? fmtInt(totals.upsell) : "—"}
                </td>
                <td className="num">
                  {totals.subs > 0 ? fmtInt(totals.subs) : "—"}
                </td>
                <td className="num">
                  {totals.frontend_rev > 0
                    ? fmtMoney(totals.frontend_rev)
                    : "—"}
                </td>
                <td className="num">
                  {totals.subs_rev > 0 ? fmtMoney(totals.subs_rev) : "—"}
                </td>
                {showManual ? (
                  <td className="num">{fmtMoney(totals.manual_rev)}</td>
                ) : null}
                <td className="num">{fmtMoney(totals.total_rev)}</td>
                <td className="num">{fmtMoney(totals.cogs)}</td>
                {showFees ? (
                  <td className="num">{fmtMoney(totalFees)}</td>
                ) : null}
                <td className="num">{fmtMoney(totals.ad_spend)}</td>
                <td
                  className={`num ${
                    totals.ad_spend > 0
                      ? totalRoas >= 3
                        ? "pos"
                        : "neg"
                      : ""
                  }`}
                >
                  {totals.ad_spend > 0 ? `${totalRoas.toFixed(2)}x` : "—"}
                </td>
                <td
                  className={`num profit ${
                    totals.net_profit >= 0 ? "pos" : "neg"
                  }`}
                >
                  {fmtMoney(totals.net_profit)}
                </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {searchable ? (
        <div className="table-foot">
          <div className="table-foot-left">
            <span className="table-foot-info">
              Currently showing{" "}
              <strong>
                {showingFrom}–{showingTo}
              </strong>{" "}
              of <strong>{filtered.length}</strong>{" "}
              {filtered.length === 1 ? "row" : "rows"}
              {footerLabel ? (
                <span className="table-foot-ctx"> · {footerLabel}</span>
              ) : null}
            </span>
            <ExportCsvButton
              headers={csvHeaders}
              rows={csvRows}
              filename={csvFilename ?? "daily-pnl"}
            />
          </div>

          <div className="table-foot-right">
            <label className="table-foot-rpp">
              <span>Rows per page</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Rows per page"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </label>

            <span className="table-foot-chip">
              Page {safePage} of {totalPages}
            </span>
            <div className="pagination-controls" aria-label="Pagination">
              <button
                type="button"
                className="pg-arrow"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="pg-arrow"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
      ) : csvFilename ? (
        <TableFooter
          count={sortedRows.length}
          label={footerLabel}
          csv={{
            headers: csvHeaders,
            rows: csvRows,
            filename: csvFilename,
          }}
        />
      ) : null}
    </div>
  );
}

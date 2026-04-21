import type { BlendedDailyRow } from "@/lib/pnl/queries";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";

type Props = {
  rows: BlendedDailyRow[];
  /** Range pills etc — rendered in the card head's right side. */
  rangeControl?: React.ReactNode;
};

/**
 * Blended daily P&L — Shopify front-end + PHX recurring side-by-side,
 * with a Total column, Net Profit pill, and a totals + averages footer.
 */
export function BlendedPnlTable({ rows, rangeControl }: Props) {
  const totals = rows.reduce(
    (acc, r) => {
      acc.orders += r.shopify_orders;
      acc.subs += r.phx_subs_billed;
      acc.shopify_rev += r.shopify_revenue;
      acc.phx_rev += r.phx_revenue;
      acc.total_rev += r.total_revenue;
      acc.ad_spend += r.shopify_ad_spend;
      acc.net_profit += r.total_net_profit;
      return acc;
    },
    {
      orders: 0,
      subs: 0,
      shopify_rev: 0,
      phx_rev: 0,
      total_rev: 0,
      ad_spend: 0,
      net_profit: 0,
    },
  );
  const totalRoas = totals.ad_spend > 0 ? totals.total_rev / totals.ad_spend : 0;

  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Daily P&amp;L · blended</div>
          <div className="card-sub">
            Shopify front-end (direct + initial) + PHX recurring / salvage,
            amortized per day from PHX snapshots
          </div>
        </div>
        {rangeControl ? (
          <div className="card-actions">{rangeControl}</div>
        ) : null}
      </div>
        <div className="table-wrap">
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Orders</th>
                <th className="num">Subs Billed</th>
                <th className="num">Shopify Rev</th>
                <th className="num">PHX Rev</th>
                <th className="num">Total Rev</th>
                <th className="num">Ad Spend</th>
                <th className="num">ROAS</th>
                <th className="num">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const roas =
                  r.shopify_ad_spend > 0 ? r.total_revenue / r.shopify_ad_spend : 0;
                const strongRoas = roas >= 3.0;
                const profitable = r.total_net_profit >= 0;
                const phxShare =
                  r.total_revenue > 0 ? (r.phx_revenue / r.total_revenue) * 100 : 0;
                return (
                  <tr key={r.date}>
                    <td>{fmtDate(r.date)}</td>
                    <td className="num muted">{fmtInt(r.shopify_orders)}</td>
                    <td className="num muted">
                      {r.phx_subs_billed > 0 ? fmtInt(r.phx_subs_billed) : "—"}
                    </td>
                    <td className="num">{fmtMoney(r.shopify_revenue)}</td>
                    <td
                      className="num"
                      style={{ color: "var(--accent-dim)" }}
                    >
                      {r.phx_revenue > 0 ? (
                        <>
                          {fmtMoney(r.phx_revenue)}
                          <span
                            style={{
                              color: "var(--muted)",
                              fontSize: 10.5,
                              marginLeft: 6,
                            }}
                          >
                            {phxShare.toFixed(0)}%
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num" style={{ fontWeight: 550 }}>
                      {fmtMoney(r.total_revenue)}
                    </td>
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
                        {fmtMoney(r.total_net_profit)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="tfoot-row">
                <td>TOTAL</td>
                <td className="num">{fmtInt(totals.orders)}</td>
                <td className="num">
                  {totals.subs > 0 ? fmtInt(totals.subs) : "—"}
                </td>
                <td className="num">{fmtMoney(totals.shopify_rev)}</td>
                <td className="num">
                  {totals.phx_rev > 0 ? fmtMoney(totals.phx_rev) : "—"}
                </td>
                <td className="num">{fmtMoney(totals.total_rev)}</td>
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
    </div>
  );
}

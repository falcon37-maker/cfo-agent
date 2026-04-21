import Link from "next/link";
import type { BlendedDailyRow } from "@/lib/pnl/queries";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";
import { ExternalLink } from "lucide-react";

/**
 * Blended daily P&L — Shopify front-end + PHX recurring side-by-side,
 * with a Total column and Net Profit pill.
 */
export function BlendedPnlTable({ rows }: { rows: BlendedDailyRow[] }) {
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
        <div className="card-actions">
          <Link href="/pnl" className="ghost-btn">
            <ExternalLink size={13} strokeWidth={2} />
            Shopify-only ledger
          </Link>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Orders</th>
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
              const roas = r.shopify_ad_spend > 0 ? r.total_revenue / r.shopify_ad_spend : 0;
              const strongRoas = roas >= 3.0;
              const profitable = r.total_net_profit >= 0;
              const phxShare =
                r.total_revenue > 0 ? (r.phx_revenue / r.total_revenue) * 100 : 0;
              return (
                <tr key={r.date}>
                  <td>{fmtDate(r.date)}</td>
                  <td className="num muted">{fmtInt(r.shopify_orders)}</td>
                  <td className="num">{fmtMoney(r.shopify_revenue)}</td>
                  <td className="num" style={{ color: "var(--accent-dim)" }}>
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
                      r.shopify_ad_spend > 0 ? (strongRoas ? "pos" : "neg") : ""
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
        </table>
      </div>
    </div>
  );
}

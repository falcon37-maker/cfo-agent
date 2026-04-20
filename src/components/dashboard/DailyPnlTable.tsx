import Link from "next/link";
import type { DailyRow } from "@/lib/pnl/queries";
import { fmtDate, fmtMoney } from "@/lib/format";
import { ExternalLink } from "lucide-react";

// 8-column rollup table used on the Dashboard.
export function DailyPnlTable({ rows }: { rows: DailyRow[] }) {
  return (
    <div className="card table-card">
      <div className="card-head">
        <div>
          <div className="card-title">Daily P&amp;L</div>
          <div className="card-sub">Rolling {rows.length} days · consolidated</div>
        </div>
        <div className="card-actions">
          <Link href="/pnl" className="ghost-btn">
            <ExternalLink size={13} strokeWidth={2} />
            Full ledger
          </Link>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pnl-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Revenue</th>
              <th className="num">Ad Spend</th>
              <th className="num">COGS</th>
              <th className="num">Fees</th>
              <th className="num">Refunds</th>
              <th className="num">Net Profit</th>
              <th className="num">ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const profitable = r.net_profit >= 0;
              const roas = r.ad_spend > 0 ? r.revenue / r.ad_spend : 0;
              const strongRoas = roas >= 3.0;
              return (
                <tr key={r.date}>
                  <td>{fmtDate(r.date)}</td>
                  <td className="num">{fmtMoney(r.revenue)}</td>
                  <td className="num muted">{fmtMoney(r.ad_spend)}</td>
                  <td className="num muted">{fmtMoney(r.cogs)}</td>
                  <td className="num muted">{fmtMoney(r.fees)}</td>
                  <td className="num muted">{fmtMoney(r.refunds)}</td>
                  <td className={`num profit ${profitable ? "pos" : "neg"}`}>
                    <span className="profit-pill">{fmtMoney(r.net_profit)}</span>
                  </td>
                  <td
                    className={`num roas ${r.ad_spend > 0 ? (strongRoas ? "pos" : "neg") : ""}`}
                  >
                    {r.ad_spend > 0 ? `${roas.toFixed(2)}x` : "—"}
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

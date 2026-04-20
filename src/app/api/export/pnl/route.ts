import { NextRequest } from "next/server";
import { loadPnlLedger } from "@/lib/pnl/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/export/pnl?range=30d&store=all|NOVA|NURA|KOVA
//   or ?from=YYYY-MM-DD&to=YYYY-MM-DD&store=…
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const storeParam = (params.get("store") ?? "all").toLowerCase();
  const storeFilter = storeParam === "all" ? "all" : storeParam.toUpperCase();

  const from = params.get("from");
  const to = params.get("to");
  const hasCustom = DATE_RE.test(from ?? "") && DATE_RE.test(to ?? "");

  const range = params.get("range") ?? "30d";
  const days = RANGE_DAYS[range] ?? 30;

  const ledger = await loadPnlLedger(
    hasCustom ? { from: from!, to: to! } : { days },
    storeFilter,
  );

  const header = [
    "Date",
    "Store",
    "Revenue",
    "Ad Spend",
    "COGS",
    "Fees",
    "Refunds",
    "Gross Profit",
    "Net Profit",
    "ROAS",
    "Margin %",
    "Orders",
  ];
  const storeLabel = storeFilter === "all" ? "ALL" : storeFilter;
  const lines = [header.join(",")];

  for (const r of ledger.rows) {
    const roas = r.ad_spend > 0 ? (r.revenue / r.ad_spend).toFixed(4) : "";
    lines.push(
      [
        r.date,
        storeLabel,
        r.revenue.toFixed(2),
        r.ad_spend.toFixed(2),
        r.cogs.toFixed(2),
        r.fees.toFixed(2),
        r.refunds.toFixed(2),
        r.gross_profit.toFixed(2),
        r.net_profit.toFixed(2),
        roas,
        r.margin_pct.toFixed(2),
        String(r.order_count),
      ].join(","),
    );
  }

  // Trailing totals row
  const t = ledger.totals;
  lines.push(
    [
      "TOTAL",
      storeLabel,
      t.revenue.toFixed(2),
      t.ad_spend.toFixed(2),
      t.cogs.toFixed(2),
      t.fees.toFixed(2),
      t.refunds.toFixed(2),
      t.gross_profit.toFixed(2),
      t.net_profit.toFixed(2),
      t.ad_spend > 0 ? t.roas.toFixed(4) : "",
      t.margin_pct.toFixed(2),
      String(t.orders),
    ].join(","),
  );

  const csv = lines.join("\n") + "\n";
  const rangeLabel = hasCustom ? `${from}_${to}` : range;
  const filename = `pnl_${storeLabel}_${rangeLabel}_${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

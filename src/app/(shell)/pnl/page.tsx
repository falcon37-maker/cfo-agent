import Link from "next/link";
import {
  Download,
  DollarSign,
  Megaphone,
  Wallet,
  Target,
  Percent,
} from "lucide-react";
import { loadPnlLedger } from "@/lib/pnl/queries";
import { requireTenant } from "@/lib/tenant";
import { fmtDate, fmtPct } from "@/lib/format";
import { SegLink } from "@/components/pnl/SegLink";
import { SubsDateRange } from "@/components/subscriptions/SubsDateRange";
import { ExpandableLedger } from "@/components/pnl/ExpandableLedger";
import { SyncDataButton } from "@/components/pnl/SyncDataButton";

export const dynamic = "force-dynamic";

const RANGES: Array<{ id: string; label: string; days: number }> = [
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
];

function resolveRange(r?: string) {
  return RANGES.find((x) => x.id === r) ?? RANGES[1]; // default 30d
}

function moneyShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function qs(params: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function parseStoreList(raw: string): string[] {
  if (!raw || raw.toLowerCase() === "all") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function PnlPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    store?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const params = await searchParams;
  const rawStoreParam = params.store ?? "";
  const selected = parseStoreList(rawStoreParam);

  // Custom `?from=&to=` overrides the preset `?range=`.
  const customFrom = DATE_RE.test(params.from ?? "") ? params.from! : undefined;
  const customTo = DATE_RE.test(params.to ?? "") ? params.to! : undefined;
  const hasCustom = Boolean(customFrom && customTo);
  const range = resolveRange(params.range);

  const tenant = await requireTenant();
  const ledger = await loadPnlLedger(
    hasCustom ? { from: customFrom!, to: customTo! } : { days: range.days },
    selected,
    tenant.id,
  );
  const { rows, totals, stores } = ledger;

  // The active set as the URL would express it (canonical comma list).
  const activeParam =
    selected.length === 0 ? "" : selected.slice().sort().join(",");

  const exportHref = `/api/export/pnl${qs(
    hasCustom
      ? { from: customFrom!, to: customTo!, store: activeParam }
      : { range: range.id, store: activeParam },
  )}`;

  // Build the multi-select chip list. "All" toggles to empty (= all stores);
  // each store chip toggles its presence in the comma list.
  const allChipActive = selected.length === 0;
  const chipHrefAll = `/pnl${qs({
    range: hasCustom ? "" : range.id,
    from: hasCustom ? customFrom! : "",
    to: hasCustom ? customTo! : "",
    // omit `store` entirely → "all"
  })}`;
  const buildToggleHref = (storeId: string): string => {
    const next = new Set(selected);
    if (next.has(storeId)) next.delete(storeId);
    else next.add(storeId);
    const param = Array.from(next).sort().join(",");
    return `/pnl${qs({
      range: hasCustom ? "" : range.id,
      from: hasCustom ? customFrom! : "",
      to: hasCustom ? customTo! : "",
      store: param,
    })}`;
  };

  const subLine = hasCustom
    ? `${fmtDate(customFrom!)} → ${fmtDate(customTo!)} (${ledger.days} day${ledger.days === 1 ? "" : "s"})`
    : `last ${range.days} days`;

  return (
    <>
      <div className="pnl-header" style={{ alignItems: "flex-start" }}>
        <div>
          <h2 className="section-title">Stores</h2>
          <div className="section-sub">
            Per-store Shopify drop-shipping P&amp;L. Processing fees ~3.9%.{" "}
            {selected.length === 0
              ? "All stores"
              : selected.length === 1
                ? selected[0]
                : `${selected.length} stores selected`} · {subLine}
          </div>
        </div>
        {/* Action buttons pinned to the top-right, on the title line. */}
        <div
          className="pnl-page-actions"
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <SyncDataButton
            sources={["shopify"]}
            storeIds={stores.map((s) => s.id)}
            description="Re-pull drop-ship store (Shopify) orders & revenue for the chosen date into the database."
          />
          <Link href={exportHref} className="primary-btn">
            <Download size={13} strokeWidth={2} />
            Export CSV
          </Link>
        </div>
        <div className="pnl-controls" style={{ flexBasis: "100%" }}>
          <div
            className="seg"
            role="tablist"
            aria-label="Range"
            style={{ order: 2, marginLeft: "auto" }}
          >
            {RANGES.map((r) => (
              <SegLink
                key={r.id}
                active={!hasCustom && r.id === range.id}
                href={`/pnl${qs({ range: r.id, store: activeParam })}`}
              >
                {r.label}
              </SegLink>
            ))}
            <SegLink
              active={hasCustom}
              href={`/pnl${qs({ store: activeParam, from: customFrom ?? "", to: customTo ?? "" })}`}
            >
              Custom
            </SegLink>
          </div>
          {/* Date range at the far right, after the range seg. */}
          <div style={{ order: 3 }}>
            <SubsDateRange
              action="/pnl"
              from={customFrom ?? rows[rows.length - 1]?.date ?? ""}
              to={customTo ?? rows[0]?.date ?? ""}
              hidden={{ store: activeParam }}
            />
          </div>
          <div
            role="group"
            aria-label="Stores"
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
              // Store chips on the left (seg + date grouped on the right).
              order: 1,
            }}
          >
            <Link
              href={chipHrefAll}
              className={`store-chip ${allChipActive ? "active" : ""}`}
              prefetch={false}
            >
              All
            </Link>
            {stores.map((s) => {
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

      <div className="pnl-totals pnl-totals-5">
        <TotalTile
          label="Total Revenue"
          value={moneyShort(totals.total_revenue)}
          icon={<DollarSign size={14} strokeWidth={1.75} />}
        />
        <TotalTile
          label="Total Ad Spend"
          value={moneyShort(totals.ad_spend)}
          icon={<Megaphone size={14} strokeWidth={1.75} />}
        />
        <TotalTile
          label="Net Profit"
          value={moneyShort(totals.net_profit)}
          tone={totals.net_profit >= 0 ? "pos" : "neg"}
          icon={<Wallet size={14} strokeWidth={1.75} />}
        />
        <TotalTile
          label="Avg ROAS"
          value={totals.ad_spend > 0 ? `${totals.roas.toFixed(2)}x` : "—"}
          tone={totals.roas >= 2 ? "pos" : totals.ad_spend > 0 ? "neg" : undefined}
          icon={<Target size={14} strokeWidth={1.75} />}
        />
        <TotalTile
          label="Net Margin"
          value={fmtPct(totals.margin_pct)}
          tone={totals.margin_pct >= 15 ? "pos" : totals.margin_pct < 0 ? "neg" : undefined}
          icon={<Percent size={14} strokeWidth={1.75} />}
        />
      </div>

      <div className="card table-card pnl-ledger-themed" style={{ borderRadius: 12 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Daily ledger</div>
            <div className="card-sub">
              {rows.length} day{rows.length === 1 ? "" : "s"} · newest first
            </div>
          </div>
        </div>
        <ExpandableLedger
          rows={rows.map((r) => ({
            date: r.date,
            order_count: r.order_count,
            phx_order_count: r.phx_order_count,
            revenue: r.revenue,
            subs_revenue: r.subs_revenue,
            ad_spend: r.ad_spend,
            cogs: r.cogs,
            fees: r.fees,
            refunds: r.refunds,
            gross_profit: r.gross_profit,
            net_profit: r.net_profit,
            total_revenue: r.total_revenue,
          }))}
          totals={{
            revenue: totals.revenue,
            subs_revenue: totals.subs_revenue,
            ad_spend: totals.ad_spend,
            cogs: totals.cogs,
            fees: totals.fees,
            refunds: totals.refunds,
            gross_profit: totals.gross_profit,
            net_profit: totals.net_profit,
            orders: totals.orders,
            roas: totals.roas,
          }}
          selectedStores={selected}
          availableStores={stores.map((s) => s.id)}
        />
      </div>
    </>
  );
}

function TotalTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
  icon?: React.ReactNode;
}) {
  return (
    <div className={`total-tile ${tone ? `tone-${tone}` : ""}`}>
      <div className="total-head">
        <div className="total-label">{label}</div>
        {icon ? <div className="total-icon">{icon}</div> : null}
      </div>
      <div className="total-value">{value}</div>
    </div>
  );
}

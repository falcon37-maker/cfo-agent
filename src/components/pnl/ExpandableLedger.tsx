"use client";

// Daily ledger with per-row expand → shows the underlying Shopify orders
// for that store-day, mirroring Shopify Admin → Orders list. The expand
// honours whatever filter the user has already picked at the top of the
// page (single store, multi-store list, or ALL), so no second prompt.
//
// Caching: per "stores|date" key — switching the filter and reopening
// is cheap because the original cache key is invalidated automatically.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronLeft,
  Plus,
  Minus,
  Loader2,
} from "lucide-react";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/format";

const ORDERS_PER_PAGE = 10;

type Row = {
  date: string;
  order_count: number;       // Shopify orders only
  phx_order_count: number;   // PHX subscription rebill events (separate)
  revenue: number;
  subs_revenue: number;
  ad_spend: number;
  cogs: number;
  fees: number;
  refunds: number;
  gross_profit: number;
  net_profit: number;
  total_revenue: number;
};

type Totals = {
  revenue: number;
  subs_revenue: number;
  ad_spend: number;
  cogs: number;
  fees: number;
  refunds: number;
  gross_profit: number;
  net_profit: number;
  orders: number;
  roas: number;
};

type ShopifyOrderRow = {
  store: string;
  id: string;
  name: string;
  createdAt: string;
  customer: string;
  channel: string;
  items: number;
  tags: string[];
  financialStatus: string;
  fulfillmentStatus: string;
  subtotal: number;
  discounts: number;
  shipping: number;
  tax: number;
  refunded: number;
  total: number;
  currency: string;
};

type PerStoreMeta = {
  store: string;
  timezone: string;
  orderCount: number;
  error?: string;
};

type DayDetails = {
  loading: boolean;
  error?: string;
  orderCount?: number;
  orders?: ShopifyOrderRow[];
  perStoreMeta?: PerStoreMeta[];
  totals?: {
    subtotal: number;
    discounts: number;
    shipping: number;
    tax: number;
    refunded: number;
    total: number;
  };
};

type Props = {
  rows: Row[];
  totals: Totals;
  /** Stores currently selected via the filter chips. Empty means "ALL". */
  selectedStores: string[];
  /** All store IDs in the workspace — not strictly needed once we always
   *  inherit the filter, but kept for forward compatibility. */
  availableStores: string[];
};

export function ExpandableLedger({
  rows,
  totals,
  selectedStores,
}: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, DayDetails>>({});
  // Pagination for the main daily-ledger rows (client-side view only — pages
  // through the days already loaded; the totals row stays full).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // Keep the expand-card's width pinned to the table-wrap viewport size,
  // not the (wider) inner table scroll width. Without this the card
  // gets clipped on the right when the parent table overflows.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => {
      el.style.setProperty("--detail-w", `${el.clientWidth}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  // Cache key includes the active store filter so changing the filter
  // doesn't show stale results from a different set of stores.
  const storeKey =
    selectedStores.length === 0 ? "ALL" : selectedStores.slice().sort().join(",");
  const rowKey = (date: string) => `${storeKey}|${date}`;

  async function fetchDay(date: string) {
    const key = rowKey(date);
    setCache((c) => ({ ...c, [key]: { loading: true } }));
    try {
      const r = await fetch(
        `/api/pnl/day-orders?date=${encodeURIComponent(date)}&store=${encodeURIComponent(storeKey)}`,
      );
      const data = await r.json();
      if (!r.ok) {
        setCache((c) => ({
          ...c,
          [key]: {
            loading: false,
            error: data?.message || data?.error || `HTTP ${r.status}`,
          },
        }));
        return;
      }
      setCache((c) => ({
        ...c,
        [key]: {
          loading: false,
          orderCount: data.orderCount,
          orders: data.orders,
          perStoreMeta: data.perStoreMeta,
          totals: data.totals,
        },
      }));
    } catch (e) {
      setCache((c) => ({
        ...c,
        [key]: {
          loading: false,
          error: (e as Error).message || "fetch failed",
        },
      }));
    }
  }

  function toggleRow(date: string) {
    const key = rowKey(date);
    const wasOpen = open[key];
    setOpen((o) => ({ ...o, [key]: !wasOpen }));
    if (!wasOpen && !cache[key]) {
      void fetchDay(date);
    }
  }

  const showStoreColumn = selectedStores.length !== 1;

  const mainTotalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const mainPage = Math.min(page, mainTotalPages);
  const mainStart = (mainPage - 1) * pageSize;
  const mainEnd = Math.min(mainStart + pageSize, rows.length);
  const pagedRows = rows.slice(mainStart, mainEnd);

  return (
    <>
    <div ref={wrapRef} className="table-wrap" style={{ maxHeight: 620 }}>
      <table className="pnl-table">
        <thead>
          <tr>
            <th style={{ width: 30, padding: 0 }}></th>
            <th>Date</th>
            <th className="num">Orders</th>
            <th className="num">Revenue</th>
            <th className="num">Ad Spend</th>
            <th className="num">COGS</th>
            <th className="num">Fees</th>
            <th className="num">ROAS</th>
            <th className="num">Net Profit</th>
          </tr>
        </thead>
        <tbody>
          {pagedRows.map((r) => {
            const roas = r.ad_spend > 0 ? r.total_revenue / r.ad_spend : 0;
            const key = rowKey(r.date);
            const isOpen = !!open[key];
            const details = cache[key];
            return (
              <FragmentRow
                key={r.date}
                r={r}
                roas={roas}
                isOpen={isOpen}
                onToggle={() => toggleRow(r.date)}
                details={details}
                showStoreColumn={showStoreColumn}
              />
            );
          })}
        </tbody>
        {rows.length > 0 ? (
          <tfoot>
            <tr className="tfoot-row">
              <td></td>
              <td>Total</td>
              <td className="num">{fmtInt(totals.orders)}</td>
              <td className="num">{fmtMoney(totals.revenue)}</td>
              <td className="num">{fmtMoney(totals.ad_spend)}</td>
              <td className="num">{fmtMoney(totals.cogs)}</td>
              <td className="num">{fmtMoney(totals.fees)}</td>
              <td
                className={`num roas ${totals.ad_spend > 0 ? (totals.roas >= 2 ? "pos" : "neg") : ""}`}
              >
                {totals.ad_spend > 0 ? `${totals.roas.toFixed(2)}x` : "—"}
              </td>
              <td
                className={`num profit ${totals.net_profit >= 0 ? "pos" : "neg"}`}
              >
                <span className="profit-pill">
                  {fmtMoney(totals.net_profit)}
                </span>
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
      {rows.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 12,
          }}
        >
          No data for this range.
        </div>
      ) : null}
    </div>
    {rows.length > 0 ? (
      <div className="table-foot">
        <div className="table-foot-left">
          <span className="table-foot-info">
            Showing{" "}
            <strong>
              {mainStart + 1}–{mainEnd}
            </strong>{" "}
            of <strong>{rows.length}</strong>{" "}
            {rows.length === 1 ? "day" : "days"}
          </span>
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
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </select>
          </label>
          <span className="table-foot-chip">
            Page {mainPage} of {mainTotalPages}
          </span>
          <div className="pagination-controls" aria-label="Pagination">
            <button
              type="button"
              className="pg-arrow"
              disabled={mainPage <= 1}
              onClick={() => setPage(mainPage - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="pg-arrow"
              disabled={mainPage >= mainTotalPages}
              onClick={() => setPage(mainPage + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function FragmentRow({
  r,
  roas,
  isOpen,
  onToggle,
  details,
  showStoreColumn,
}: {
  r: Row;
  roas: number;
  isOpen: boolean;
  onToggle: () => void;
  details: DayDetails | undefined;
  showStoreColumn: boolean;
}) {
  return (
    <>
      <tr className={isOpen ? "row-open" : undefined}>
        <td style={{ padding: 0 }}>
          <button
            type="button"
            className="row-expand-btn"
            onClick={onToggle}
            aria-label={isOpen ? "Collapse day details" : "Expand day details"}
            aria-expanded={isOpen}
            title={isOpen ? "Hide orders" : "Show orders for this day"}
          >
            {isOpen ? <Minus size={12} strokeWidth={2.5} /> : <Plus size={12} strokeWidth={2.5} />}
          </button>
        </td>
        <td>{fmtDate(r.date)}</td>
        <td className="num muted">{fmtInt(r.order_count)}</td>
        <td className="num">{fmtMoney(r.revenue)}</td>
        <td className="num muted">{fmtMoney(r.ad_spend)}</td>
        <td className="num muted">{fmtMoney(r.cogs)}</td>
        <td className="num muted">{fmtMoney(r.fees)}</td>
        <td
          className={`num roas ${r.ad_spend > 0 ? (roas >= 2 ? "pos" : "neg") : ""}`}
        >
          {r.ad_spend > 0 ? `${roas.toFixed(2)}x` : "—"}
        </td>
        <td className={`num profit ${r.net_profit >= 0 ? "pos" : "neg"}`}>
          <span className="profit-pill">{fmtMoney(r.net_profit)}</span>
        </td>
      </tr>
      {isOpen ? (
        <tr className="day-detail-row">
          <td colSpan={9}>
            <div className="day-detail-sticky">
              <div className="day-detail">
                <DayDetailPanel
                  details={details}
                  showStoreColumn={showStoreColumn}
                />
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DayDetailPanel({
  details,
  showStoreColumn,
}: {
  details: DayDetails | undefined;
  showStoreColumn: boolean;
}) {
  if (!details || details.loading) {
    return (
      <div className="day-detail-state">
        <Loader2 size={14} className="spin" />
        <span>Loading orders from Shopify…</span>
      </div>
    );
  }
  if (details.error) {
    return (
      <div className="day-detail-state err">
        Could not load orders: {details.error}
      </div>
    );
  }
  if (!details.orders || details.orders.length === 0) {
    return (
      <div className="day-detail-state">
        No orders in Shopify for this day.
      </div>
    );
  }

  const t = details.totals!;
  const meta = details.perStoreMeta ?? [];
  // Show stat chips only for stores that actually have orders to keep
  // the header clean. Skipped stores (no creds in env) are silently
  // omitted — the orders table itself is the source of truth for which
  // stores contributed data.
  const active = meta.filter((m) => !m.error && m.orderCount > 0);
  const skipped = meta.filter((m) => m.error);

  return (
    <div className="day-detail-inner">
      <div className="day-detail-head">
        <div className="day-detail-stats">
          <Stat label="Orders" value={fmtInt(details.orderCount ?? 0)} />
          <Stat label="Subtotal" value={fmtMoney(t.subtotal)} />
          <Stat
            label="Discounts"
            value={t.discounts > 0 ? `-${fmtMoney(t.discounts)}` : "—"}
            tone={t.discounts > 0 ? "muted" : undefined}
          />
          <Stat label="Shipping" value={fmtMoney(t.shipping)} tone="muted" />
          <Stat label="Tax" value={fmtMoney(t.tax)} tone="muted" />
          <Stat
            label="Refunds"
            value={t.refunded > 0 ? `-${fmtMoney(t.refunded)}` : "—"}
            tone={t.refunded > 0 ? "neg" : undefined}
          />
          <Stat label="Total" value={fmtMoney(t.total)} strong />
        </div>
        {active.length > 1 ? (
          <div className="day-detail-stores">
            {active.map((m) => (
              <span
                key={m.store}
                className="store-meta-chip"
                title={`${m.orderCount} orders · ${m.timezone}`}
              >
                {m.store}
                <span className="store-meta-count">{m.orderCount}</span>
              </span>
            ))}
            {skipped.length > 0 ? (
              <span
                className="store-meta-chip muted"
                title={skipped
                  .map((s) => `${s.store}: credentials not configured`)
                  .join("\n")}
              >
                {skipped.length} store{skipped.length === 1 ? "" : "s"} skipped
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <OrdersTable
        orders={details.orders}
        showStoreColumn={showStoreColumn}
        storeTz={Object.fromEntries(meta.map((m) => [m.store, m.timezone]))}
      />
    </div>
  );
}

function OrdersTable({
  orders,
  showStoreColumn,
  storeTz,
}: {
  orders: ShopifyOrderRow[];
  showStoreColumn: boolean;
  storeTz: Record<string, string>;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(orders.length / ORDERS_PER_PAGE));
  // Clamp current page when the order set changes (e.g. switching stores).
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * ORDERS_PER_PAGE;
  const end = Math.min(start + ORDERS_PER_PAGE, orders.length);
  const pageOrders = useMemo(
    () => orders.slice(start, end),
    [orders, start, end],
  );

  return (
    <div className="day-orders-block">
      <div className="day-orders-wrap">
        <table className="day-orders-table">
          <thead>
            <tr>
              <th>Order</th>
              {showStoreColumn ? <th>Store</th> : null}
              <th>Date</th>
              <th>Customer</th>
              <th>Channel</th>
              <th className="num">Total</th>
              <th>Payment status</th>
              <th>Fulfillment status</th>
              <th>Items</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {pageOrders.map((o) => (
              <tr key={`${o.store}|${o.id}`}>
                <td className="mono">
                  <span className="order-name">{o.name}</span>
                </td>
                {showStoreColumn ? (
                  <td>
                    <span className="store-tag">{o.store}</span>
                  </td>
                ) : null}
                <td className="muted nowrap">{formatTime(o.createdAt, storeTz[o.store])}</td>
                <td className="truncate" title={o.customer}>
                  {o.customer}
                </td>
                <td className="muted">{o.channel}</td>
                <td className="num" style={{ fontWeight: 600 }}>
                  {fmtMoney(o.total)}
                </td>
                <td>
                  <span
                    className={`pill pill-${(o.financialStatus || "").toLowerCase()}`}
                  >
                    <span className="pill-dot" />
                    {(o.financialStatus || "").toLowerCase().replace(/_/g, " ")}
                  </span>
                </td>
                <td>
                  <span
                    className={`pill pill-${(o.fulfillmentStatus || "").toLowerCase()}`}
                  >
                    <span className="pill-dot" />
                    {(o.fulfillmentStatus || "").toLowerCase().replace(/_/g, " ")}
                  </span>
                </td>
                <td className="muted nowrap">
                  {o.items} {o.items === 1 ? "item" : "items"}
                </td>
                <td>
                  <TagList tags={o.tags} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {orders.length > ORDERS_PER_PAGE ? (
        <Pagination
          page={safePage}
          totalPages={totalPages}
          rangeStart={start + 1}
          rangeEnd={end}
          total={orders.length}
          onChange={setPage}
        />
      ) : null}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const canPrev = page > 1;
  const canNext = page < totalPages;
  const pageNumbers = computePageNumbers(page, totalPages);

  return (
    <div className="orders-pagination">
      <div className="pagination-info">
        <strong>{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</strong>{" "}
        of <strong>{total.toLocaleString()}</strong> orders
      </div>
      <div className="pagination-controls">
        <button
          type="button"
          className="pg-arrow"
          onClick={() => onChange(page - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
          title="Previous"
        >
          <ChevronLeft size={14} />
        </button>
        {pageNumbers.map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="pg-gap">
              ⋯
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={`pg-num ${p === page ? "active" : ""}`}
              onClick={() => onChange(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="pg-arrow"
          onClick={() => onChange(page + 1)}
          disabled={!canNext}
          aria-label="Next page"
          title="Next"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

// Build a Shopify/Ant-style page-number array with edge + neighbour pages.
// Examples (current page in bold-equivalent):
//   total=5,  page=3  → [1, 2, 3, 4, 5]
//   total=10, page=1  → [1, 2, 3, 4, 5, …, 10]
//   total=10, page=5  → [1, …, 4, 5, 6, …, 10]
//   total=10, page=10 → [1, …, 6, 7, 8, 9, 10]
function computePageNumbers(
  page: number,
  total: number,
): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: Array<number | "…"> = [1];
  const left = Math.max(2, page - 1);
  const right = Math.min(total - 1, page + 1);
  if (left > 2) out.push("…");
  for (let i = left; i <= right; i++) out.push(i);
  if (right < total - 1) out.push("…");
  out.push(total);
  return out;
}

function Stat({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "muted" | "neg";
  strong?: boolean;
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${strong ? "strong" : ""}`}>{value}</div>
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags || tags.length === 0) return <span className="muted">—</span>;
  const visible = tags.slice(0, 2);
  const overflow = tags.length - visible.length;
  return (
    <span className="tag-list">
      {visible.map((t) => (
        <span key={t} className="tag-chip" title={t}>
          {t}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="tag-chip tag-chip-overflow" title={tags.join(", ")}>
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

// Display in the STORE's timezone — mirrors Shopify Admin. This matches
// the day-bucket label above (the row was grouped under "May 31" because
// the order was placed May 31 in store-local; the time should say the
// same). Without store-tz, an order placed 11:54 pm May 31 store-local
// would render as "Jun 1 8:54 am" in the user's browser tz, contradicting
// its own group label.
function formatTime(iso: string, tz?: string): string {
  try {
    const d = new Date(iso);
    const zone = tz && tz !== "?" ? tz : undefined;

    const time = d
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: zone,
      })
      .toLowerCase();

    // "Today/Yesterday" comparisons also in store tz so the boundary
    // aligns with the day-bucket the row sits under.
    const ymdInTz = (date: Date): string =>
      date.toLocaleDateString("en-CA", { timeZone: zone });
    const today = ymdInTz(new Date());
    const orderDay = ymdInTz(d);
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = ymdInTz(y);

    if (orderDay === today) return `Today at ${time}`;
    if (orderDay === yesterday) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: zone,
    })} at ${time}`;
  } catch {
    return iso;
  }
}

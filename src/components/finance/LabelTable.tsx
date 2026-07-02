"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  X,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { fmtDate, fmtMoney } from "@/lib/format";
import { SubsDateRange } from "@/components/subscriptions/SubsDateRange";
import type { LabelRow } from "@/lib/zoho/labels";
import {
  acceptLabelAction,
  rejectLabelAction,
} from "@/app/(shell)/finance/actions";

type SortKey = "date" | "name" | "amount" | "confidence";
type SortDir = "asc" | "desc";

const PAGE_SIZES = [10, 25, 50, 100];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "suggested", label: "Pending" },
  { value: "applied", label: "In Zoho" },
  { value: "rejected", label: "Rejected" },
];

function confTone(c: number | null): string {
  if (c == null) return "var(--muted-strong)";
  if (c >= 0.85) return "var(--accent)";
  if (c >= 0.6) return "var(--warning, #ffb020)";
  return "var(--negative)";
}

/** A readable name for a transaction: payee if present, else the first
 *  meaningful segment of the bank description. */
function txnName(r: LabelRow): string {
  const p = (r.payee ?? "").trim();
  if (p) return p;
  const d = (r.description ?? "").trim();
  if (!d) return "—";
  const seg = d.split(/[;|]/)[0].trim();
  return seg || "—";
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const clamp2: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const ellipsis1: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Map a Zoho account type to a short badge (so the reviewer sees where a
 *  record will land in Zoho: income / expense / transfer / equity). */
function acctTypeBadge(
  type?: string,
): { label: string; color: string } | null {
  if (!type) return null;
  if (type === "income") return { label: "Income", color: "var(--positive)" };
  if (type === "expense" || type === "cost_of_goods_sold" || type === "other_expense")
    return { label: "Expense", color: "var(--negative)" };
  if (type === "bank" || type === "credit_card")
    return { label: "Transfer", color: "var(--muted-strong)" };
  if (type === "equity") return { label: "Equity", color: "var(--accent)" };
  return { label: type.replace(/_/g, " "), color: "var(--muted-strong)" };
}

export function LabelTable({
  rows,
  accountNumbers = {},
  accountTypes = {},
}: {
  rows: LabelRow[];
  accountNumbers?: Record<string, string>;
  accountTypes?: Record<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState<string | null>(null);
  const [selectedCats, setSelectedCats] = useState<Set<string>>(new Set());
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    new Set(),
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filterOpen]);

  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const c = r.suggested_category_name;
      if (c) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [rows]);
  const categories = useMemo(
    () => [...catCounts.keys()].sort((a, b) => a.localeCompare(b)),
    [catCounts],
  );

  const { defFrom, defTo } = useMemo(() => {
    const ds = (rows.map((r) => r.txn_date).filter(Boolean) as string[]).sort();
    const f = ds[0] ?? new Date().toISOString().slice(0, 10);
    return { defFrom: f, defTo: ds[ds.length - 1] ?? f };
  }, [rows]);

  function applyPreset(days: number) {
    const t = new Date();
    const f = new Date(t);
    f.setDate(f.getDate() - (days - 1));
    setFrom(isoDay(f));
    setTo(isoDay(t));
    setPreset(`${days}d`);
  }

  function toggleCat(name: string) {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleStatus(s: string) {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function clearAll() {
    setQuery("");
    setFrom("");
    setTo("");
    setPreset(null);
    setSelectedCats(new Set());
    setSelectedStatuses(new Set());
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (selectedStatuses.size > 0 && !selectedStatuses.has(r.status)) return false;
      if (from && (r.txn_date ?? "") < from) return false;
      if (to && (r.txn_date ?? "") > to) return false;
      if (selectedCats.size > 0 && !selectedCats.has(r.suggested_category_name ?? "")) {
        return false;
      }
      if (q && !txnName(r).toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") cmp = (a.txn_date ?? "").localeCompare(b.txn_date ?? "");
      else if (sortKey === "name") cmp = txnName(a).localeCompare(txnName(b));
      else if (sortKey === "amount") cmp = Number(a.amount ?? 0) - Number(b.amount ?? 0);
      else if (sortKey === "confidence") cmp = (a.confidence ?? -1) - (b.confidence ?? -1);
      return cmp * dir;
    });
    return out;
  }, [rows, query, from, to, selectedCats, selectedStatuses, sortKey, sortDir]);

  // Reset to page 1 whenever the filter/sort result changes (render-time guard).
  const filterKey = `${query}|${from}|${to}|${[...selectedCats].sort().join(",")}|${[...selectedStatuses].sort().join(",")}|${sortKey}|${sortDir}|${pageSize}`;
  const [prevKey, setPrevKey] = useState(filterKey);
  if (filterKey !== prevKey) {
    setPrevKey(filterKey);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(view.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const sliceStart = (safePage - 1) * pageSize;
  const paged = view.slice(sliceStart, sliceStart + pageSize);
  const showingFrom = view.length === 0 ? 0 : sliceStart + 1;
  const showingTo = Math.min(sliceStart + pageSize, view.length);

  const popoverFilters = selectedCats.size + selectedStatuses.size;
  const activeFilters =
    (from || to ? 1 : 0) + selectedCats.size + (query ? 1 : 0) + selectedStatuses.size;

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (col !== sortKey) return <ArrowUpDown size={11} style={{ opacity: 0.4 }} />;
    return sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
  };

  const sortableTh = (label: string, col: SortKey, num = false) => (
    <th className={num ? "num" : ""}>
      <button
        type="button"
        onClick={() => toggleSort(col)}
        style={{
          background: "transparent",
          border: 0,
          cursor: "pointer",
          color: "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: 0,
        }}
      >
        {label}
        <SortIcon col={col} />
      </button>
    </th>
  );

  return (
    <section>
      {/* ── Filter bar: search + Filter (left) · date range (right) ── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: "6px 10px",
            background: "var(--surface)",
            minWidth: 220,
          }}
        >
          <Search size={13} style={{ color: "var(--muted)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            style={{ border: 0, outline: "none", background: "transparent", color: "var(--text)", fontSize: 12.5, width: "100%" }}
          />
        </div>

        {/* Filter popover — categories only, sits right next to search */}
        <div ref={filterRef} style={{ position: "relative" }}>
          <button type="button" className="ghost-btn" onClick={() => setFilterOpen((o) => !o)} style={{ padding: "6px 11px" }}>
            <SlidersHorizontal size={13} strokeWidth={2} />
            Filter
            {popoverFilters > 0 ? (
              <span
                style={{
                  marginLeft: 2,
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 8,
                  background: "var(--accent)",
                  color: "var(--on-accent)",
                  fontSize: 10,
                  fontWeight: 600,
                  display: "inline-grid",
                  placeItems: "center",
                }}
              >
                {popoverFilters}
              </span>
            ) : null}
          </button>

          {filterOpen ? (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                zIndex: 100,
                width: 300,
                maxHeight: "calc(100vh - 220px)",
                overflowY: "auto",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                boxShadow: "0 12px 32px -8px rgba(0,0,0,0.35)",
                padding: 14,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-strong)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Status / Action
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                {STATUS_OPTIONS.map((s) => {
                  const on = selectedStatuses.has(s.value);
                  return (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => toggleStatus(s.value)}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 999,
                        fontSize: 12,
                        border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                        background: on ? "var(--accent)" : "var(--surface)",
                        color: on ? "var(--on-accent)" : "var(--text-dim)",
                        fontWeight: on ? 600 : 500,
                        cursor: "pointer",
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>

              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-strong)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                AI Category {selectedCats.size > 0 ? `(${selectedCats.size})` : ""}
              </div>
              <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                {categories.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>No categories yet.</div>
                ) : (
                  categories.map((c) => (
                    <label key={c} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "5px 6px", borderRadius: 6, cursor: "pointer" }}>
                      <input type="checkbox" checked={selectedCats.has(c)} onChange={() => toggleCat(c)} />
                      <span style={{ flex: 1, ...ellipsis1 }}>{c}</span>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>{catCounts.get(c)}</span>
                    </label>
                  ))
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <button type="button" className="ghost-btn" style={{ padding: "5px 10px" }} onClick={() => setSelectedCats(new Set())}>
                  Clear
                </button>
                <button type="button" className="primary-btn" style={{ padding: "5px 12px" }} onClick={() => setFilterOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Date range — pushed to the right */}
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div className="seg" role="tablist" aria-label="Date range">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" className={preset === `${d}d` ? "active" : ""} onClick={() => applyPreset(d)}>
                {d}d
              </button>
            ))}
            <button type="button" className={preset === "custom" ? "active" : ""} onClick={() => setPreset("custom")}>
              Custom
            </button>
          </div>
          <SubsDateRange
            from={from || defFrom}
            to={to || defTo}
            onApply={(f, t) => {
              setFrom(f);
              setTo(t);
              setPreset("custom");
            }}
          />
          {activeFilters > 0 ? (
            <button type="button" className="ghost-btn" style={{ padding: "5px 10px" }} onClick={clearAll}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="card table-card pnl-ledger-themed" style={{ borderRadius: 12 }}>
        <div className="table-wrap" style={{ minHeight: 460 }}>
          <table className="pnl-table" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                {sortableTh("Date", "date")}
                <th>Account</th>
                {sortableTh("Name", "name")}
                {sortableTh("Amount", "amount", true)}
                <th>Zoho Account (category)</th>
                {sortableTh("Conf.", "confidence", true)}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r) => {
                // Zoho convention (bank = asset): debit = money IN (deposit),
                // credit = money OUT (withdrawal).
                const isMoneyIn = (r.debit_or_credit ?? "") === "debit";
                return (
                  <tr key={r.transaction_id}>
                    <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                      {r.txn_date ? fmtDate(r.txn_date) : "—"}
                    </td>
                    <td style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                      {r.account_name || "—"}
                      {accountNumbers[r.account_id] ? (
                        <span className="muted" style={{ marginLeft: 5, fontSize: 10.5 }}>
                          ••{accountNumbers[r.account_id]}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <div style={{ width: 220, maxWidth: 220 }}>
                        <div style={{ fontWeight: 500, ...ellipsis1 }} title={txnName(r)}>
                          {txnName(r)}
                        </div>
                        <div className="muted" style={{ fontSize: 11, lineHeight: 1.4, ...clamp2 }} title={r.description ?? ""}>
                          {r.description}
                        </div>
                      </div>
                    </td>
                    <td className="num" style={{ color: isMoneyIn ? "var(--accent)" : "var(--negative)", whiteSpace: "nowrap" }}>
                      {isMoneyIn ? "+" : "−"}
                      {fmtMoney(Math.abs(Number(r.amount ?? 0)))}
                    </td>
                    <td>
                      <div style={{ width: 280, maxWidth: 280 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span
                            style={{ fontWeight: 550, flex: 1, ...ellipsis1 }}
                            title={r.suggested_category_name ?? ""}
                          >
                            {r.suggested_category_name ?? "—"}
                          </span>
                          {(() => {
                            const b = acctTypeBadge(accountTypes[r.suggested_account_id ?? ""]);
                            return b ? (
                              <span
                                style={{
                                  flexShrink: 0,
                                  fontSize: 9.5,
                                  fontWeight: 700,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.04em",
                                  padding: "1px 6px",
                                  borderRadius: 5,
                                  background: "var(--surface-3)",
                                  color: b.color,
                                }}
                              >
                                {b.label}
                              </span>
                            ) : null;
                          })()}
                        </div>
                        {r.reasoning ? (
                          <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.4, ...clamp2 }} title={r.reasoning}>
                            {r.reasoning}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="num" style={{ color: confTone(r.confidence), fontWeight: 600 }}>
                      {r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "—"}
                    </td>
                    <td>
                      {r.status !== "applied" && r.status !== "rejected" ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <form action={acceptLabelAction}>
                            <input type="hidden" name="transaction_id" value={r.transaction_id} />
                            <button
                              type="submit"
                              className="primary-btn"
                              disabled={!r.suggested_account_id}
                              style={{ padding: "5px 10px" }}
                              title="Accept — categorize this transaction in Zoho Books"
                            >
                              <Check size={12} strokeWidth={2.5} /> Accept
                            </button>
                          </form>
                          <form action={rejectLabelAction}>
                            <input type="hidden" name="transaction_id" value={r.transaction_id} />
                            <button
                              type="submit"
                              className="ghost-btn"
                              style={{ padding: "5px 10px" }}
                              title="Reject — do not categorize in Zoho"
                            >
                              <X size={12} strokeWidth={2.5} /> Reject
                            </button>
                          </form>
                        </div>
                      ) : r.status === "applied" ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "4px 10px",
                            borderRadius: 6,
                            background: "var(--positive-bg)",
                            color: "var(--positive)",
                            fontSize: 11.5,
                            fontWeight: 600,
                          }}
                        >
                          <Check size={12} strokeWidth={2.5} /> In Zoho
                        </span>
                      ) : (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "4px 10px",
                            borderRadius: 6,
                            background: "var(--surface-3)",
                            color: "var(--muted-strong)",
                            fontSize: 11.5,
                            fontWeight: 600,
                          }}
                        >
                          <X size={12} strokeWidth={2.5} /> Rejected
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {view.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      textAlign: "center",
                      color: "var(--muted)",
                      // Keep the empty table as tall as a populated one so the
                      // page (and the Filter popover above it) doesn't collapse.
                      height: 440,
                      verticalAlign: "middle",
                    }}
                  >
                    No transactions match the filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ── */}
        <div className="table-foot">
          <div className="table-foot-left">
            <span className="table-foot-info">
              Showing <strong>{showingFrom}–{showingTo}</strong> of <strong>{view.length}</strong>{" "}
              {view.length === 1 ? "row" : "rows"}
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
      </div>
    </section>
  );
}

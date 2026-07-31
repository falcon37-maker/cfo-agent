"use client";

import { useState } from "react";
import { Check, Send, ChevronLeft, ChevronRight } from "lucide-react";
import { StoreSelect, type StoreOption } from "@/components/entry/StoreSelect";
import { DatePicker } from "@/components/entry/DatePicker";
import { AmountInput } from "@/components/entry/AmountInput";
import { EntryHistoryRow } from "@/components/entry/EntryHistoryRow";
import { fmtDate } from "@/lib/format";
import {
  submitAdSpendAction,
  updateAdSpendEntryAction,
  deleteAdSpendEntryAction,
} from "./actions";

type Recent = {
  id: string;
  store_id: string;
  date: string;
  amount: number;
};

const PLATFORMS = [
  { id: "meta", name: "Meta", color: "#6b7bff" },
  { id: "google", name: "Google", color: "#ffb020" },
  { id: "tiktok", name: "TikTok", color: "#ff4d5e" },
];

// History rows per page. Keeps the aside roughly the form's height instead of
// running 30 rows past the bottom of the page.
const HISTORY_PAGE_SIZE = 8;

export function AdsForm({
  stores,
  recent,
  today,
}: {
  stores: StoreOption[];
  recent: Recent[];
  today: string;
}) {
  const [store, setStore] = useState(stores[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [platform, setPlatform] = useState("meta");
  const [parsed, setParsed] = useState(0);
  const [campaign, setCampaign] = useState("");
  // Bumped only by "Clear" to remount (and wipe) the uncontrolled AmountInput.
  // Must NOT depend on `parsed`, or every keystroke would remount the input and
  // steal focus after a single digit.
  const [resetKey, setResetKey] = useState(0);
  const [page, setPage] = useState(1);

  const storeObj = stores.find((s) => s.id === store);
  const platObj = PLATFORMS.find((p) => p.id === platform);

  // Paginate the history purely client-side — `recent` is already the 30 rows
  // the server sent, so paging never refetches.
  const pageCount = Math.max(1, Math.ceil(recent.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const sliceStart = (safePage - 1) * HISTORY_PAGE_SIZE;
  const pageRows = recent.slice(sliceStart, sliceStart + HISTORY_PAGE_SIZE);
  const showingFrom = recent.length === 0 ? 0 : sliceStart + 1;
  const showingTo = Math.min(sliceStart + HISTORY_PAGE_SIZE, recent.length);

  return (
    <div className="entry-grid entry-grid-fill">
      <form
        action={submitAdSpendAction}
        className="card entry-card"
      >
        <input type="hidden" name="store" value={store} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="platform" value={platform} />

        <div className="card-head">
          <div>
            <div className="card-title">New ad spend entry</div>
            <div className="card-sub">One store · one platform · one day</div>
          </div>
          <span className="status-pill status-pos">
            <span className="pill-dot" />
            Draft
          </span>
        </div>

        <div className="entry-body">
          <label className="field">
            <span className="field-label">Store</span>
            <StoreSelect value={store} onChange={setStore} options={stores} />
          </label>

          <label className="field">
            <span className="field-label">Platform</span>
            <div className="plat-row">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`plat-btn ${platform === p.id ? "active" : ""}`}
                  onClick={() => setPlatform(p.id)}
                >
                  <span className="plat-dot" style={{ background: p.color }} />
                  {p.name}
                </button>
              ))}
            </div>
            <div className="field-hint">
              Platform tag is informational — all spend is currently rolled up
              into the single <strong>facebook</strong> platform key so it lands
              alongside historical CSV data.
            </div>
          </label>

          <label className="field">
            <span className="field-label">Date</span>
            <DatePicker value={date} onChange={setDate} max={today} />
          </label>

          <label className="field">
            <span className="field-label">
              Spend amount
              <span className="field-aside mono">USD</span>
            </span>
            <AmountInput key={resetKey} name="amount" onValueChange={setParsed} />
            <div className="field-hint">
              Paste from Ads Manager —{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>$4,820.00</code>,
              commas or spaces are fine. Total {platObj?.name} spend for{" "}
              <strong>{storeObj?.name}</strong> on{" "}
              <strong>{fmtDate(date)}</strong>.
            </div>
          </label>

          <label className="field">
            <span className="field-label">
              Campaign{" "}
              <span className="field-aside" style={{ color: "var(--muted)" }}>
                optional
              </span>
            </span>
            <div className="field-input">
              <Send size={14} strokeWidth={2} />
              <input
                type="text"
                name="campaign"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
                placeholder="Spring-Retarget-03"
              />
            </div>
          </label>
        </div>

        <div className="entry-foot">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setParsed(0);
              setCampaign("");
              setResetKey((k) => k + 1);
            }}
          >
            Clear
          </button>
          <button type="submit" className="primary-btn" disabled={!parsed}>
            <Check size={13} strokeWidth={2.3} />
            Save spend entry
          </button>
        </div>
      </form>

      <aside className="entry-aside">
        <div className="preview-card">
          <div className="preview-label">Live preview</div>
          <div className="preview-row">
            <span className="plat-dot inline" style={{ background: platObj?.color }} />
            {platObj?.name} · {storeObj?.name} · {fmtDate(date)}
          </div>
          <div className="preview-big">
            {parsed
              ? `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
              : "$0.00"}
          </div>
          <div className="preview-meta">
            <div>
              <span className="pm-lbl">Feeds into</span>
              <span className="pm-val">Daily P&amp;L · ROAS · CAC</span>
            </div>
            <div>
              <span className="pm-lbl">Rule</span>
              <span className="pm-val mono">net_profit subtracts ad spend</span>
            </div>
          </div>
        </div>

        <div className="card entry-history-card">
          <div className="card-head">
            <div>
              <div className="card-title small">History</div>
              <div className="card-sub">
                Most recent {recent.length} · click the pencil to edit, trash to delete
              </div>
            </div>
          </div>
          <div className="entry-history-scroll">
            <table className="pnl-table entry-history">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Store</th>
                  <th className="num">Spend</th>
                  <th className="num" style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--muted)", padding: 16 }}>
                      No submissions yet.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((r) => (
                    <EntryHistoryRow
                      key={r.id}
                      entry={r}
                      stores={stores}
                      today={today}
                      amountName="amount"
                      editAction={updateAdSpendEntryAction}
                      deleteAction={deleteAdSpendEntryAction}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {recent.length > 0 ? (
            <div className="table-foot entry-history-foot">
              <div className="table-foot-left">
                <span className="table-foot-info">
                  Showing <strong>{showingFrom}–{showingTo}</strong> of{" "}
                  <strong>{recent.length}</strong>
                </span>
              </div>
              <div className="table-foot-right">
                <span className="table-foot-chip">
                  Page {safePage} of {pageCount}
                </span>
                <div className="pagination-controls" aria-label="Pagination">
                  <button
                    type="button"
                    className="pg-arrow"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft size={14} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="pg-arrow"
                    disabled={safePage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

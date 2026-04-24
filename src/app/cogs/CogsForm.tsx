"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { StoreSelect, type StoreOption } from "@/components/entry/StoreSelect";
import { DatePicker } from "@/components/entry/DatePicker";
import { AmountInput } from "@/components/entry/AmountInput";
import { EntryHistoryRow } from "@/components/entry/EntryHistoryRow";
import { fmtDate } from "@/lib/format";
import {
  submitCogsAction,
  updateCogsEntryAction,
  deleteCogsEntryAction,
} from "./actions";

type Recent = {
  id: string;
  store_id: string;
  date: string;
  cogs: number;
};

export function CogsForm({
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
  const [parsed, setParsed] = useState(0);
  const [note, setNote] = useState("");

  const storeObj = stores.find((s) => s.id === store);

  return (
    <div className="entry-grid">
      <form
        key={`cogs-${parsed}`}
        action={submitCogsAction}
        className="card entry-card"
      >
        <input type="hidden" name="store" value={store} />
        <input type="hidden" name="date" value={date} />

        <div className="card-head">
          <div>
            <div className="card-title">New COGS entry</div>
            <div className="card-sub">One store · one day</div>
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
            <span className="field-label">Date</span>
            <DatePicker value={date} onChange={setDate} max={today} />
            <div className="field-hint">
              Only one day per entry. Re-submitting the same day overwrites it.
            </div>
          </label>

          <label className="field">
            <span className="field-label">
              COGS amount
              <span className="field-aside mono">USD</span>
            </span>
            <AmountInput name="cogs" onValueChange={setParsed} />
            <div className="field-hint">
              Paste anything — <code style={{ fontFamily: "var(--font-mono)" }}>$1,234.56</code>,{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>1234.567</code>, spaces — we
              clean it. Total COGS for <strong>{storeObj?.name}</strong> on{" "}
              <strong>{fmtDate(date)}</strong>.
            </div>
          </label>

          <label className="field">
            <span className="field-label">
              Note{" "}
              <span className="field-aside" style={{ color: "var(--muted)" }}>
                optional
              </span>
            </span>
            <textarea
              className="field-textarea"
              rows={2}
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Includes restocking fee from supplier X"
            />
          </label>
        </div>

        <div className="entry-foot">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setParsed(0);
              setNote("");
            }}
          >
            Clear
          </button>
          <button type="submit" className="primary-btn" disabled={!parsed}>
            <Check size={13} strokeWidth={2.3} />
            Save COGS entry
          </button>
        </div>
      </form>

      <aside className="entry-aside">
        <div className="preview-card">
          <div className="preview-label">Live preview</div>
          <div className="preview-row">
            <span>
              {storeObj?.name} · {fmtDate(date)}
            </span>
          </div>
          <div className="preview-big">
            {parsed
              ? `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
              : "$0.00"}
          </div>
          <div className="preview-meta">
            <div>
              <span className="pm-lbl">Feeds into</span>
              <span className="pm-val">Daily P&amp;L · Net Profit</span>
            </div>
            <div>
              <span className="pm-lbl">Rule</span>
              <span className="pm-val mono">net = rev − cogs − fees − refunds − ads</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title small">History</div>
              <div className="card-sub">
                Most recent {recent.length} · click the pencil to edit, trash to delete
              </div>
            </div>
          </div>
          <table className="pnl-table entry-history">
            <thead>
              <tr>
                <th>Date</th>
                <th>Store</th>
                <th className="num">Amount</th>
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
                recent.map((r) => (
                  <EntryHistoryRow
                    key={r.id}
                    entry={{
                      id: r.id,
                      store_id: r.store_id,
                      date: r.date,
                      amount: r.cogs,
                    }}
                    stores={stores}
                    today={today}
                    amountName="cogs"
                    editAction={updateCogsEntryAction}
                    deleteAction={deleteCogsEntryAction}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}

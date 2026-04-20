"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { StoreSelect, type StoreOption } from "@/components/entry/StoreSelect";
import { DatePicker } from "@/components/entry/DatePicker";
import { fmtMoney, fmtDate } from "@/lib/format";
import { submitCogsAction } from "./actions";

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
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const storeObj = stores.find((s) => s.id === store);
  const parsed = Number(amount) || 0;

  return (
    <div className="entry-grid">
      <form action={submitCogsAction} className="card entry-card">
        <input type="hidden" name="store" value={store} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="cogs" value={amount} />

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
            <div className="field-input field-amount">
              <span className="amount-prefix">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                required
              />
            </div>
            <div className="field-hint">
              Total cost of goods sold for <strong>{storeObj?.name}</strong> on{" "}
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
              setAmount("");
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
              <div className="card-title small">Recent entries</div>
              <div className="card-sub">Last {recent.length} · across stores</div>
            </div>
          </div>
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Store</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ textAlign: "center", color: "var(--muted)", padding: 16 }}>
                    No submissions yet.
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date)}</td>
                    <td style={{ color: "var(--text)" }}>{r.store_id}</td>
                    <td className="num">{fmtMoney(r.cogs)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}

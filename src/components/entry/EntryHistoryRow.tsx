"use client";

import { useState } from "react";
import { Pencil, Trash2, Check, X } from "lucide-react";
import { StoreSelect, type StoreOption } from "@/components/entry/StoreSelect";
import { DatePicker } from "@/components/entry/DatePicker";
import { AmountInput } from "@/components/entry/AmountInput";
import { fmtDate, fmtMoney } from "@/lib/format";

export type EntryRow = {
  id: string;
  store_id: string;
  date: string;
  amount: number;
};

/**
 * One row in the audit-log history table. Click pencil → inline edit
 * (store / date / amount). Click trash → confirm dialog then submit delete.
 *
 * `editAction` and `deleteAction` are passed as server action function refs
 * so the form posts go straight to the action without an intermediate API
 * route. `amountName` is the form field name the action expects ("cogs" vs
 * "amount").
 */
export function EntryHistoryRow({
  entry,
  stores,
  today,
  amountName,
  editAction,
  deleteAction,
}: {
  entry: EntryRow;
  stores: StoreOption[];
  today: string;
  amountName: "cogs" | "amount";
  editAction: (f: FormData) => void;
  deleteAction: (f: FormData) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [store, setStore] = useState(entry.store_id);
  const [date, setDate] = useState(entry.date);
  const [amount, setAmount] = useState(entry.amount);

  if (mode === "edit") {
    return (
      <tr className="edit-row">
        <td colSpan={4}>
          <form action={editAction} className="inline-edit-form">
            <input type="hidden" name="id" value={entry.id} />
            <input type="hidden" name="store" value={store} />
            <input type="hidden" name="date" value={date} />
            <div className="inline-edit-grid">
              <div style={{ minWidth: 200 }}>
                <StoreSelect value={store} onChange={setStore} options={stores} />
              </div>
              <div style={{ minWidth: 200 }}>
                <DatePicker value={date} onChange={setDate} max={today} />
              </div>
              <AmountInput
                name={amountName}
                defaultValue={String(entry.amount)}
                onValueChange={setAmount}
              />
              <div className="inline-edit-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Cancel"
                  onClick={() => {
                    setStore(entry.store_id);
                    setDate(entry.date);
                    setAmount(entry.amount);
                    setMode("view");
                  }}
                >
                  <X size={14} strokeWidth={2} />
                </button>
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={!amount || amount < 0}
                >
                  <Check size={13} strokeWidth={2.3} />
                  Save
                </button>
              </div>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  if (mode === "confirm-delete") {
    return (
      <tr className="confirm-row">
        <td colSpan={4}>
          <form action={deleteAction} className="inline-edit-form">
            <input type="hidden" name="id" value={entry.id} />
            <div className="inline-edit-grid" style={{ alignItems: "center" }}>
              <span style={{ color: "var(--negative)" }}>
                Delete {entry.store_id} · {fmtDate(entry.date)} ·{" "}
                {fmtMoney(entry.amount)}?
              </span>
              <div className="inline-edit-actions" style={{ gridColumn: "span 3" }}>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Cancel delete"
                  onClick={() => setMode("view")}
                >
                  <X size={14} strokeWidth={2} />
                </button>
                <button
                  type="submit"
                  className="primary-btn"
                  style={{ background: "var(--negative)", borderColor: "var(--negative)" }}
                >
                  <Trash2 size={13} strokeWidth={2.3} />
                  Delete
                </button>
              </div>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{fmtDate(entry.date)}</td>
      <td style={{ color: "var(--text)" }}>{entry.store_id}</td>
      <td className="num">{fmtMoney(entry.amount)}</td>
      <td className="num" style={{ width: 80 }}>
        <div className="row-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Edit entry"
            title="Edit"
            onClick={() => setMode("edit")}
          >
            <Pencil size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            aria-label="Delete entry"
            title="Delete"
            onClick={() => setMode("confirm-delete")}
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </div>
      </td>
    </tr>
  );
}

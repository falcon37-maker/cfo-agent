"use client";

import { useState } from "react";
import { DatePicker } from "@/components/entry/DatePicker";

/**
 * GET form with two custom DatePickers. Submits `from` + `to` query params
 * (plus any `hidden` fields) to `action`. Used on /pnl, /subscriptions, and
 * the dashboard so the elegant date picker is consistent across the app.
 */
export function DateRangeForm({
  action,
  from,
  to,
  hidden = {},
  submitLabel = "Apply",
  submitClassName = "ghost-btn",
}: {
  action: string;
  from?: string;
  to?: string;
  hidden?: Record<string, string>;
  /** Text on the submit button. Defaults to "Apply". */
  submitLabel?: string;
  /** Button style class. Defaults to "ghost-btn"; pass "primary-btn" for a
   *  filled accent button. */
  submitClassName?: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [fromVal, setFromVal] = useState(from ?? addDays(today, -29));
  const [toVal, setToVal] = useState(to ?? today);

  return (
    <form
      method="get"
      action={action}
      style={{
        display: "inline-flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      <div className="date-range-group">
        <div style={{ minWidth: 210 }}>
          <DatePicker value={fromVal} onChange={setFromVal} max={toVal} />
        </div>
        <input type="hidden" name="from" value={fromVal} />

        <span style={{ color: "var(--muted)", fontSize: 12 }}>→</span>

        <div style={{ minWidth: 210 }}>
          <DatePicker value={toVal} onChange={setToVal} max={today} />
        </div>
        <input type="hidden" name="to" value={toVal} />
      </div>

      <button type="submit" className={submitClassName}>
        {submitLabel}
      </button>
    </form>
  );
}

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

"use client";

// Dual-month date-range picker (paysight-style) for the Subscriptions filter
// bar. One pill shows "from → to"; the popup has quick presets, two month
// grids with range selection, and Reset / Apply Date Range. On apply it just
// navigates with ?from&to (+ preserved params) — no business logic.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Calendar, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";

type Props = {
  /** Navigate to this path with ?from&to on apply. Omit when using onApply. */
  action?: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  /** Extra query params to preserve on apply (e.g. { store: "NOVA" }). */
  hidden?: Record<string, string>;
  /** Optional "MAX HISTORY N DAYS" hint shown on the trigger. */
  maxHistoryDays?: number;
  /** Controlled mode: called with the picked range instead of navigating.
   *  Used for client-side table filters (e.g. the dashboard P&L card). */
  onApply?: (from: string, to: string) => void;
};

function parseLocal(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtShort(ymd: string): string {
  if (!ymd) return "—";
  return parseLocal(ymd).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SubsDateRange({
  action,
  from,
  to,
  hidden = {},
  maxHistoryDays,
  onApply,
}: Props) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const maxStr = iso(today);

  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [view, setView] = useState<Date>(() =>
    firstOfMonth(parseLocal(from || maxStr)),
  );

  // Open/close. On open, re-sync the tentative selection to the applied range
  // (done in the handler, not an effect, to avoid cascading renders).
  function toggleOpen() {
    if (!open) {
      setStart(from);
      setEnd(to);
      setView(firstOfMonth(parseLocal(from || maxStr)));
    }
    setOpen(!open);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const isFuture = (d: Date) => iso(d) > maxStr;

  function pick(dStr: string) {
    if (!start || (start && end)) {
      // begin a new range
      setStart(dStr);
      setEnd("");
    } else if (dStr < start) {
      // clicked before the current start → restart from there
      setStart(dStr);
    } else {
      setEnd(dStr);
    }
  }

  function setRange(s: Date, e: Date) {
    const sc = iso(s) > maxStr ? today : s;
    const ec = iso(e) > maxStr ? today : e;
    setStart(iso(sc));
    setEnd(iso(ec));
    setView(firstOfMonth(sc));
  }

  // ── Quick presets ─────────────────────────────────────────────────────
  const presetsTop: Array<{ label: string; run: () => void }> = [
    { label: "Today", run: () => setRange(today, today) },
    {
      label: "Yesterday",
      run: () => setRange(addDays(today, -1), addDays(today, -1)),
    },
    {
      label: "This Week",
      run: () => {
        const dow = (today.getDay() + 6) % 7; // Mon = 0
        setRange(addDays(today, -dow), today);
      },
    },
    {
      label: "Last Week",
      run: () => {
        const dow = (today.getDay() + 6) % 7;
        const thisMon = addDays(today, -dow);
        setRange(addDays(thisMon, -7), addDays(thisMon, -1));
      },
    },
    {
      label: "This Month",
      run: () => setRange(firstOfMonth(today), today),
    },
    {
      label: "Last Month",
      run: () => {
        const lm = addMonths(today, -1);
        setRange(lm, addDays(firstOfMonth(today), -1));
      },
    },
  ];
  const presetsBottom: Array<{ label: string; run: () => void }> = [
    {
      label: "Last 3 Months",
      run: () => setRange(addMonths(today, -3), today),
    },
    {
      label: "Last 6 Months",
      run: () => setRange(addMonths(today, -6), today),
    },
    {
      label: "Year to Date",
      run: () => setRange(new Date(today.getFullYear(), 0, 1, 12), today),
    },
    {
      label: "Last Year",
      run: () =>
        setRange(
          new Date(today.getFullYear() - 1, 0, 1, 12),
          new Date(today.getFullYear() - 1, 11, 31, 12),
        ),
    },
  ];

  function apply() {
    const f = start || iso(today);
    const t = end || f;
    setOpen(false);
    // Controlled mode (client-side filter): hand the range back, don't navigate.
    if (onApply) {
      onApply(f, t);
      return;
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(hidden)) if (v) params.set(k, v);
    params.set("from", f);
    params.set("to", t);
    router.push(`${action ?? ""}?${params.toString()}`);
  }

  function reset() {
    setStart(from);
    setEnd(to);
    setView(firstOfMonth(parseLocal(from || maxStr)));
  }

  function renderMonth(base: Date) {
    const startDow = (new Date(base.getFullYear(), base.getMonth(), 1).getDay() + 6) % 7;
    const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const prevDays = new Date(base.getFullYear(), base.getMonth(), 0).getDate();
    const cells: Array<{ d: number; muted: boolean; date: Date }> = [];
    for (let i = 0; i < startDow; i++) {
      const d = prevDays - startDow + 1 + i;
      cells.push({ d, muted: true, date: new Date(base.getFullYear(), base.getMonth() - 1, d, 12) });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      cells.push({ d: i, muted: false, date: new Date(base.getFullYear(), base.getMonth(), i, 12) });
    }
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const i = cells.length - startDow - daysInMonth + 1;
      cells.push({ d: i, muted: true, date: new Date(base.getFullYear(), base.getMonth() + 1, i, 12) });
    }

    return (
      <div className="dr-month">
        <div className="dr-month-label">
          {base.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        <div className="dr-dow">
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="dr-grid">
          {cells.map((c, i) => {
            const s = iso(c.date);
            const isStart = !c.muted && s === start;
            const isEnd = !c.muted && s === end;
            const inRange =
              !c.muted && start && end && s > start && s < end;
            const isToday = !c.muted && s === maxStr;
            const disabled = isFuture(c.date);
            return (
              <button
                key={i}
                type="button"
                disabled={disabled}
                className={[
                  "dr-cell",
                  c.muted ? "muted" : "",
                  isStart ? "start" : "",
                  isEnd ? "end" : "",
                  inRange ? "in-range" : "",
                  isToday ? "today" : "",
                  disabled ? "disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => pick(s)}
              >
                {c.d}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="dr-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`dr-trigger ${open ? "open" : ""}`}
        onClick={toggleOpen}
      >
        <Calendar size={14} strokeWidth={2} />
        <span className="dr-value">
          {fmtShort(start)} <span className="dr-arrow">→</span> {fmtShort(end || start)}
        </span>
        {maxHistoryDays ? (
          <span className="dr-maxhint">MAX {maxHistoryDays}D</span>
        ) : null}
        <ChevronDown size={13} strokeWidth={2} className="dr-chev" />
      </button>

      {open ? (
        <div className="dr-pop">
          <div className="dr-presets dr-presets-top">
            {presetsTop.map((p) => (
              <button key={p.label} type="button" className="dr-preset" onClick={p.run}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="dr-head">
            <button
              type="button"
              className="dr-nav"
              onClick={() => setView(addMonths(view, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="dr-nav"
              onClick={() => setView(addMonths(view, 1))}
              aria-label="Next month"
            >
              <ChevronRight size={15} strokeWidth={2} />
            </button>
          </div>

          <div className="dr-months">
            {renderMonth(view)}
            {renderMonth(addMonths(view, 1))}
          </div>

          <div className="dr-presets dr-presets-bottom">
            {presetsBottom.map((p) => (
              <button key={p.label} type="button" className="dr-preset" onClick={p.run}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="dr-foot">
            <button type="button" className="dr-reset" onClick={reset}>
              Reset
            </button>
            <button type="button" className="dr-apply" onClick={apply}>
              Apply Date Range
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

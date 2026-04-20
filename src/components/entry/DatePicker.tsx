"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";

type Props = {
  value: string; // YYYY-MM-DD
  onChange: (v: string) => void;
  max?: string; // YYYY-MM-DD — disables cells after this date
};

export function DatePicker({ value, onChange, max }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const valDate = value ? parseLocalDate(value) : new Date();
  const maxDate = max ? parseLocalDate(max) : null;
  const [view, setView] = useState(
    () => new Date(valDate.getFullYear(), valDate.getMonth(), 1),
  );

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) setView(new Date(valDate.getFullYear(), valDate.getMonth(), 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fmtTrigger = (d: Date) =>
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const sameDay = (a: Date, b: Date) => iso(a) === iso(b);
  const isFuture = (d: Date) => {
    if (!maxDate) return false;
    return iso(d) > iso(maxDate);
  };

  const startDow = (new Date(view.getFullYear(), view.getMonth(), 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const prevDays = new Date(view.getFullYear(), view.getMonth(), 0).getDate();

  const cells: Array<{ d: number; muted: boolean; date: Date }> = [];
  for (let i = 0; i < startDow; i++) {
    const d = prevDays - startDow + 1 + i;
    cells.push({
      d,
      muted: true,
      date: new Date(view.getFullYear(), view.getMonth() - 1, d, 12),
    });
  }
  for (let i = 1; i <= daysInMonth; i++) {
    cells.push({
      d: i,
      muted: false,
      date: new Date(view.getFullYear(), view.getMonth(), i, 12),
    });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const i = cells.length - startDow - daysInMonth + 1;
    cells.push({
      d: i,
      muted: true,
      date: new Date(view.getFullYear(), view.getMonth() + 1, i, 12),
    });
  }

  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const monthLabel = view.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const shiftMonth = (delta: number) =>
    setView(new Date(view.getFullYear(), view.getMonth() + delta, 1));

  const pickQuick = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(12, 0, 0, 0);
    if (isFuture(d)) return;
    onChange(iso(d));
    setOpen(false);
  };

  return (
    <div className="dp-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`dp-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Calendar size={14} strokeWidth={2} />
        <span className="dp-value">{fmtTrigger(valDate)}</span>
        <ChevronDown size={13} strokeWidth={2} className="dp-chev" />
      </button>

      {open ? (
        <div className="dp-pop">
          <div className="dp-quick">
            <button type="button" onClick={() => pickQuick(0)}>
              Today
            </button>
            <button type="button" onClick={() => pickQuick(-1)}>
              Yesterday
            </button>
            <button type="button" onClick={() => pickQuick(-7)}>
              7 days ago
            </button>
          </div>
          <div className="dp-head">
            <button
              type="button"
              className="dp-nav"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
            >
              <ChevronLeft size={14} strokeWidth={2} />
            </button>
            <div className="dp-month">{monthLabel}</div>
            <button
              type="button"
              className="dp-nav"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
            >
              <ChevronRight size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="dp-dow">
            {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="dp-grid">
            {cells.map((c, i) => {
              const selected = !c.muted && sameDay(c.date, valDate);
              const isToday = !c.muted && sameDay(c.date, today);
              const disabled = isFuture(c.date);
              return (
                <button
                  key={i}
                  type="button"
                  className={[
                    "dp-cell",
                    c.muted ? "muted" : "",
                    selected ? "selected" : "",
                    isToday ? "today" : "",
                    disabled ? "disabled" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={disabled}
                  onClick={() => {
                    onChange(iso(c.date));
                    setOpen(false);
                  }}
                >
                  {c.d}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parseLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

export type StoreOption = {
  id: string;
  name: string;
  url: string;
  badge?: string;
};

export function StoreSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: StoreOption[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((s) => s.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!current) return null;

  return (
    <div className="store-select" ref={ref}>
      <button
        type="button"
        className={`store-select-btn ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <div className="ss-logo">{current.id.slice(0, 1)}</div>
        <div className="ss-body">
          <div className="ss-name">{current.name}</div>
          <div className="ss-url">{current.url}</div>
        </div>
        <ChevronDown size={13} strokeWidth={2} className="ss-chev" />
      </button>
      {open ? (
        <div className="store-menu">
          {options.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`store-menu-item ${s.id === value ? "active" : ""}`}
              onClick={() => {
                onChange(s.id);
                setOpen(false);
              }}
            >
              <div className="ss-logo small">{s.id.slice(0, 1)}</div>
              <div className="ss-body">
                <div className="ss-name">{s.name}</div>
                <div className="ss-url">{s.url}</div>
              </div>
              {s.badge ? <div className="ss-rev">{s.badge}</div> : null}
              {s.id === value ? (
                <Check size={13} strokeWidth={2.3} color="var(--accent)" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { BlendedDailyRow } from "@/lib/pnl/queries";
import { BlendedPnlTable } from "./BlendedPnlTable";

type Preset = "7d" | "30d" | "90d" | "custom";
const PRESET_DAYS: Record<Exclude<Preset, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Client-side date range filter — lives inside the P&L card header. */
export function PnlTableWithRange({ pool }: { pool: BlendedDailyRow[] }) {
  const [preset, setPreset] = useState<Preset>("30d");
  const defaultFrom = pool[0]?.date ?? "";
  const defaultTo = pool[pool.length - 1]?.date ?? "";
  const [fromStr, setFromStr] = useState(defaultFrom);
  const [toStr, setToStr] = useState(defaultTo);

  const rows = useMemo(() => {
    if (pool.length === 0) return pool;
    if (preset === "custom") {
      if (!DATE_RE.test(fromStr) || !DATE_RE.test(toStr)) return pool;
      return pool
        .filter((r) => r.date >= fromStr && r.date <= toStr)
        .slice()
        .reverse();
    }
    const days = PRESET_DAYS[preset];
    return pool.slice(-days).slice().reverse();
  }, [pool, preset, fromStr, toStr]);

  const control = (
    <div className="pnl-table-controls">
      <div className="seg" role="tablist" aria-label="Table range">
        {(Object.keys(PRESET_DAYS) as Array<Exclude<Preset, "custom">>).map(
          (id) => (
            <button
              key={id}
              type="button"
              className={preset === id ? "active" : ""}
              onClick={() => setPreset(id)}
            >
              {id}
            </button>
          ),
        )}
        <button
          type="button"
          className={preset === "custom" ? "active" : ""}
          onClick={() => setPreset("custom")}
        >
          Custom
        </button>
      </div>
      {preset === "custom" ? (
        <div className="pnl-table-custom">
          <input
            type="date"
            value={fromStr}
            min={defaultFrom}
            max={defaultTo}
            onChange={(e) => setFromStr(e.target.value)}
            className="pnl-date-input"
          />
          <span className="sep">→</span>
          <input
            type="date"
            value={toStr}
            min={defaultFrom}
            max={defaultTo}
            onChange={(e) => setToStr(e.target.value)}
            className="pnl-date-input"
          />
        </div>
      ) : null}
    </div>
  );

  return <BlendedPnlTable rows={rows} rangeControl={control} />;
}

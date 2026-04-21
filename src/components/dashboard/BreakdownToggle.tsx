"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export function BreakdownToggle({
  label = "Show breakdown",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="breakdown-wrap">
      <button
        type="button"
        className="breakdown-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronUp size={12} strokeWidth={2} />
        ) : (
          <ChevronDown size={12} strokeWidth={2} />
        )}
        {open ? "Hide breakdown" : label}
      </button>
      {open ? <div className="breakdown-body">{children}</div> : null}
    </div>
  );
}

"use client";

// Bulk-confirm control for the review queue. Pick a confidence bar (the count
// at each level is shown) and confirm every pending suggestion at/above it in
// one click — so hundreds don't need manual review. Only the lower-confidence
// ones are left to check by hand.

import { useFormStatus } from "react-dom";
import { CheckCheck, Loader2 } from "lucide-react";
import { confirmBulkAction } from "@/app/(shell)/finance/actions";

export type BulkCounts = {
  c90: number;
  c80: number;
  c70: number;
  all: number;
};

function Btn() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="primary-btn"
      disabled={pending}
      style={{ padding: "6px 12px" }}
    >
      {pending ? (
        <>
          <Loader2 size={13} className="spin" /> Confirming…
        </>
      ) : (
        <>
          <CheckCheck size={13} strokeWidth={2} /> Confirm
        </>
      )}
    </button>
  );
}

export function BulkConfirmButton({ counts }: { counts: BulkCounts }) {
  return (
    <form
      action={confirmBulkAction}
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <select
        name="min"
        defaultValue="0.9"
        title="Confirm every pending suggestion at or above this confidence"
        style={{
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid var(--border-strong)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <option value="0.9">≥ 90% confidence ({counts.c90})</option>
        <option value="0.8">≥ 80% confidence ({counts.c80})</option>
        <option value="0.7">≥ 70% confidence ({counts.c70})</option>
        <option value="0">All pending ({counts.all})</option>
      </select>
      <Btn />
    </form>
  );
}

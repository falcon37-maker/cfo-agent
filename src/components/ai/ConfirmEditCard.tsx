"use client";

// Confirmation card for a pending edit. Rendered inside the chat thread
// after an edit-mode tool call. The user clicks Confirm or Cancel; we
// POST /api/chat/confirm with the pending_id and surface the result.
//
// One card per confirmation. If the model staged multiple in one turn
// (rare), ChatWidget renders one card per item.

import { useState } from "react";
import { Check, X, AlertCircle, Loader2 } from "lucide-react";

export type PendingConfirmation = {
  pending_id: string;
  tool_name: string;
  target_table: string;
  target_pk: Record<string, unknown>;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown>;
  human_summary: string;
  /** Initial status. When loaded from history this may be 'confirmed',
   *  'cancelled', or 'expired' — in which case we render a read-only
   *  badge instead of action buttons. */
  status?: "pending" | "confirmed" | "cancelled" | "expired";
};

type Props = {
  confirmation: PendingConfirmation;
  /** Called after the user resolves the card. The parent uses this
   *  to insert a follow-up "Done" / "Cancelled" message into the chat. */
  onResolved: (result: {
    pending_id: string;
    applied: boolean;
    cancelled: boolean;
    summary: string;
    error?: string;
  }) => void;
};

type LocalState = "idle" | "submitting" | "applied" | "cancelled" | "error";

export function ConfirmEditCard({ confirmation, onResolved }: Props) {
  // Initialise from the server-provided status so a history-loaded card
  // shows its final state without the user being able to re-apply.
  const initialState: LocalState =
    confirmation.status === "confirmed"
      ? "applied"
      : confirmation.status === "cancelled"
        ? "cancelled"
        : confirmation.status === "expired"
          ? "error"
          : "idle";
  const [state, setState] = useState<LocalState>(initialState);
  const [errorMsg, setErrorMsg] = useState<string | null>(
    confirmation.status === "expired" ? "Expired before confirmation" : null,
  );

  const before = extractAmount(confirmation.before_value);
  const after = extractAmount(confirmation.after_value);
  const reason = extractReason(confirmation.after_value);
  const diff =
    before != null && after != null ? round2(after - before) : null;

  async function resolve(action: "confirm" | "cancel") {
    setState("submitting");
    setErrorMsg(null);
    try {
      const r = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pending_id: confirmation.pending_id,
          action,
        }),
      });
      const data = (await r.json()) as {
        ok?: boolean;
        applied?: boolean;
        message?: string;
        summary?: string;
        status?: string;
        error?: string;
        prior_status?: "confirmed" | "cancelled" | "expired";
      };
      if (!r.ok || !data.ok) {
        // 409 with prior_status: someone (or another tab) already
        // resolved this card. Don't show a red error — render the
        // accurate final state and let the parent know it's resolved.
        if (r.status === 409 && data.prior_status) {
          if (data.prior_status === "confirmed") {
            setState("applied");
            onResolved({
              pending_id: confirmation.pending_id,
              applied: true,
              cancelled: false,
              summary: confirmation.human_summary,
            });
            return;
          }
          if (data.prior_status === "cancelled") {
            setState("cancelled");
            onResolved({
              pending_id: confirmation.pending_id,
              applied: false,
              cancelled: true,
              summary: confirmation.human_summary,
            });
            return;
          }
          // expired falls through to the generic error path below.
        }
        setState("error");
        setErrorMsg(data.message || "Couldn't process that change.");
        onResolved({
          pending_id: confirmation.pending_id,
          applied: false,
          cancelled: false,
          summary: confirmation.human_summary,
          error: data.message || "failed",
        });
        return;
      }
      const applied = action === "confirm" && data.applied === true;
      setState(applied ? "applied" : "cancelled");
      onResolved({
        pending_id: confirmation.pending_id,
        applied,
        cancelled: action === "cancel",
        summary: data.summary || confirmation.human_summary,
      });
    } catch (e) {
      setState("error");
      const msg = e instanceof Error ? e.message : "Network error";
      setErrorMsg(msg);
      onResolved({
        pending_id: confirmation.pending_id,
        applied: false,
        cancelled: false,
        summary: confirmation.human_summary,
        error: msg,
      });
    }
  }

  const disabled = state === "submitting" || state === "applied" || state === "cancelled";

  return (
    <div className={`cec ${state}`}>
      <div className="cec-header">
        <AlertCircle size={14} />
        <span>Confirm change</span>
      </div>

      <div className="cec-summary">{confirmation.human_summary}</div>

      {(before != null || after != null) && (
        <div className="cec-grid">
          {before != null && (
            <div className="cec-cell">
              <div className="cec-label">Current</div>
              <div className="cec-value cec-current">${fmt(before)}</div>
            </div>
          )}
          {after != null && (
            <div className="cec-cell">
              <div className="cec-label">New</div>
              <div className="cec-value cec-new">${fmt(after)}</div>
            </div>
          )}
          {diff != null && (
            <div className="cec-cell">
              <div className="cec-label">Difference</div>
              <div
                className={
                  "cec-value " + (diff >= 0 ? "cec-up" : "cec-down")
                }
              >
                {diff >= 0 ? "+" : ""}${fmt(diff)}
              </div>
            </div>
          )}
        </div>
      )}

      {reason && <div className="cec-reason">Reason: {reason}</div>}

      {state === "idle" && (
        <div className="cec-actions">
          <button
            type="button"
            className="cec-cancel"
            disabled={disabled}
            onClick={() => resolve("cancel")}
          >
            <X size={14} />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            className="cec-confirm"
            disabled={disabled}
            onClick={() => resolve("confirm")}
          >
            <Check size={14} />
            <span>Confirm</span>
          </button>
        </div>
      )}

      {state === "submitting" && (
        <div className="cec-status">
          <Loader2 size={14} className="cec-spin" />
          <span>Applying…</span>
        </div>
      )}

      {state === "applied" && (
        <div className="cec-status cec-status-ok">
          <Check size={14} />
          <span>Applied</span>
        </div>
      )}
      {state === "cancelled" && (
        <div className="cec-status cec-status-muted">
          <X size={14} />
          <span>Cancelled</span>
        </div>
      )}
      {state === "error" && (
        <div className="cec-status cec-status-err">
          <AlertCircle size={14} />
          <span>{errorMsg || "Failed"}</span>
        </div>
      )}

      <style jsx>{`
        .cec {
          background: var(--surface);
          border: 1px solid var(--border-strong);
          border-radius: 14px;
          padding: 14px 16px;
          margin-top: 4px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
        }
        .cec.applied {
          border-color: var(--accent-dim);
          background: var(--accent-bg);
        }
        .cec.cancelled,
        .cec.error {
          opacity: 0.85;
        }
        .cec-header {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: var(--warning);
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 8px;
        }
        .cec-summary {
          font-size: 13.5px;
          font-weight: 600;
          color: var(--text);
          line-height: 1.4;
          margin-bottom: 12px;
        }
        .cec-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
          gap: 10px;
          padding: 10px 12px;
          background: var(--surface-2);
          border-radius: 10px;
          border: 1px solid var(--border);
          margin-bottom: 12px;
        }
        .cec-cell {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .cec-label {
          font-size: 10.5px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 600;
        }
        .cec-value {
          font-size: 13.5px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--text);
        }
        .cec-current {
          color: var(--text-dim);
        }
        .cec-new {
          color: var(--text);
        }
        .cec-up {
          color: var(--accent);
        }
        .cec-down {
          color: var(--negative);
        }
        .cec-reason {
          font-size: 12px;
          color: var(--text-dim);
          margin-bottom: 12px;
          line-height: 1.45;
        }
        .cec-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .cec-cancel,
        .cec-confirm {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: 999px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid var(--border);
          background: var(--surface-2);
          color: var(--text);
          transition: background 0.12s, border-color 0.12s, color 0.12s;
          font-family: var(--font-sans), sans-serif;
        }
        .cec-cancel:hover:not(:disabled) {
          background: var(--negative-bg);
          border-color: var(--negative);
          color: var(--negative);
        }
        .cec-confirm {
          background: var(--accent);
          color: var(--on-accent);
          border-color: var(--accent);
        }
        .cec-confirm:hover:not(:disabled) {
          background: var(--accent-strong);
        }
        .cec-cancel:disabled,
        .cec-confirm:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .cec-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12.5px;
          font-weight: 600;
          color: var(--muted-strong);
        }
        .cec-status-ok {
          color: var(--accent);
        }
        .cec-status-muted {
          color: var(--muted);
        }
        .cec-status-err {
          color: var(--negative);
        }
        .cec-spin {
          animation: cecSpin 1s linear infinite;
        }
        @keyframes cecSpin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function extractAmount(v: Record<string, unknown> | null): number | null {
  if (!v) return null;
  const t = v.total_amount;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractReason(v: Record<string, unknown>): string | null {
  const r = v.reason;
  return typeof r === "string" && r.trim() ? r.trim() : null;
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

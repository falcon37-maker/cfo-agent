"use client";

// "Sync & label from Zoho" button + date modal. Pick All / a single date / a
// date range; the action pulls that window's uncategorized transactions from
// Zoho into the DB and AI-labels them. Reuses the .sync-modal styles.

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { RefreshCw, X, Loader2 } from "lucide-react";
import { syncFromZohoAction } from "@/app/(shell)/finance/actions";

type Mode = "all" | "single" | "range";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="primary-btn" disabled={pending}>
      {pending ? (
        <>
          <Loader2 size={13} className="spin" /> Syncing…
        </>
      ) : (
        <>
          <RefreshCw size={13} strokeWidth={2} /> Sync now
        </>
      )}
    </button>
  );
}

export function SyncFromZohoButton() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("all");
  const [from, setFrom] = useState(todayUtc());
  const [to, setTo] = useState(todayUtc());

  // What goes into the hidden inputs the server action reads.
  const fromVal = mode === "all" ? "" : from;
  const toVal = mode === "all" ? "" : mode === "single" ? from : to;

  return (
    <>
      <button type="button" className="primary-btn" onClick={() => setOpen(true)}>
        <RefreshCw size={13} strokeWidth={2} />
        Sync from Zoho
      </button>

      {open ? (
        <div className="sync-modal-root">
          <div className="sync-modal-backdrop" onClick={() => setOpen(false)} />
          <div className="sync-modal" role="dialog" aria-modal="true">
            <header className="sync-modal-head">
              <div>
                <div className="sync-modal-title">Sync from Zoho</div>
                <div className="sync-modal-sub">
                  Choose how much to sync. The AI pulls that window&apos;s
                  uncategorized Zoho transactions into the database and suggests
                  a category for each — added to the review queue below.
                </div>
              </div>
              <button
                type="button"
                className="sync-modal-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>

            <form action={syncFromZohoAction}>
              <div className="sync-modal-body">
                <div className="sync-mode-toggle">
                  <button
                    type="button"
                    className={`sync-seg ${mode === "all" ? "active" : ""}`}
                    onClick={() => setMode("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`sync-seg ${mode === "single" ? "active" : ""}`}
                    onClick={() => setMode("single")}
                  >
                    Single date
                  </button>
                  <button
                    type="button"
                    className={`sync-seg ${mode === "range" ? "active" : ""}`}
                    onClick={() => setMode("range")}
                  >
                    Date range
                  </button>
                </div>

                {mode === "single" ? (
                  <label className="sync-field">
                    <span>Date</span>
                    <input
                      type="date"
                      value={from}
                      max={todayUtc()}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                ) : mode === "range" ? (
                  <div className="sync-field-row">
                    <label className="sync-field">
                      <span>From</span>
                      <input
                        type="date"
                        value={from}
                        max={to}
                        onChange={(e) => setFrom(e.target.value)}
                      />
                    </label>
                    <label className="sync-field">
                      <span>To</span>
                      <input
                        type="date"
                        value={to}
                        max={todayUtc()}
                        onChange={(e) => setTo(e.target.value)}
                      />
                    </label>
                  </div>
                ) : null}

                <p className="sync-note">
                  {mode === "all"
                    ? "Syncs every uncategorized transaction — the first run can take several minutes. Keep this tab open."
                    : "Syncs only the selected window — already-imported transactions are skipped."}
                </p>

                <input type="hidden" name="from" value={fromVal} />
                <input type="hidden" name="to" value={toVal} />
              </div>

              <footer className="sync-modal-foot">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </button>
                <SubmitButton />
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

"use client";

// "Sync Data" button + modal on the P&L page. Lets the operator re-pull a
// chosen date (or short range) across Shopify + Paysight + Phoenix on demand,
// so a specific day's data can be brought up to date with the live sources
// without waiting for the cron.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

type SyncResult = {
  ok: boolean;
  from?: string;
  to?: string;
  days?: number;
  shopify?: { orders: number; failed: number };
  paysight?: { subs: number; tx: number; failed: number } | { skipped: string };
  phoenix?:
    | { activeSubscribers: number | null; revenueWalk: string; chunks: number }
    | { skipped: string };
  elapsedMs?: number;
  error?: string;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type SyncDataButtonProps = {
  /** Which sources to sync. Omit to sync all (Shopify + Paysight + Phoenix).
   *  The Subscriptions page passes ["paysight","phoenix"] so it only refreshes
   *  the subscription side. */
  sources?: Array<"shopify" | "paysight" | "phoenix">;
  /** Restrict the Shopify sync to these store IDs. Omit to sync all stores.
   *  The Stores page passes the drop-ship stores so it doesn't also re-sync
   *  the subscription stores (NOVA/NURA/KOVA). */
  storeIds?: string[];
  /** Short blurb under the modal title describing what gets pulled. */
  description?: string;
  /** When false, the API skips the slow Phoenix per-customer revenue walk and
   *  only refreshes the fast subscriber counts — so the click returns in
   *  seconds. Defaults to true (full sync). */
  phoenixRevenue?: boolean;
};

export function SyncDataButton({
  sources,
  storeIds,
  description,
  phoenixRevenue = true,
}: SyncDataButtonProps = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"single" | "range">("single");
  const [from, setFrom] = useState(todayUtc());
  const [to, setTo] = useState(todayUtc());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState("");

  async function runSync() {
    setRunning(true);
    setResult(null);
    setError(null);
    setPct(0);
    setPhase("Starting…");
    try {
      const window = mode === "single" ? { from, to: from } : { from, to };
      const body = {
        ...window,
        ...(sources && sources.length ? { sources } : {}),
        ...(storeIds && storeIds.length ? { storeIds } : {}),
        ...(phoenixRevenue ? {} : { phoenixRevenue: false }),
      };
      const r = await fetch("/api/sync/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!r.ok || !r.body) {
        // Validation errors (400/401) come back as plain JSON, not a stream.
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "Sync failed. Please try again.");
        return;
      }

      // Read the NDJSON progress stream line by line.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: SyncResult | null = null;
      let streamErr: string | null = null;

      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep the partial last line
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: {
            type: string;
            pct?: number;
            label?: string;
            error?: string;
          } & SyncResult;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "progress") {
            if (typeof evt.pct === "number") setPct(evt.pct);
            if (evt.label) setPhase(evt.label);
          } else if (evt.type === "done") {
            done = evt;
          } else if (evt.type === "error") {
            streamErr = evt.error ?? "Sync failed.";
          }
        }
      }

      if (streamErr) {
        setError(streamErr);
      } else if (done) {
        setPct(100);
        setResult(done);
        // Refresh the ledger so the new numbers show without a manual reload.
        router.refresh();
      } else {
        setError("Sync ended unexpectedly. Please try again.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ghost-btn"
        onClick={() => setOpen(true)}
        title="Re-sync a specific date with the live sources"
      >
        <RefreshCw size={13} strokeWidth={2} />
        Sync Data
      </button>

      {open ? (
        <div className="sync-modal-root">
          <div
            className="sync-modal-backdrop"
            onClick={() => !running && setOpen(false)}
          />
          <div className="sync-modal" role="dialog" aria-modal="true">
            <header className="sync-modal-head">
              <div>
                <div className="sync-modal-title">Sync data</div>
                <div className="sync-modal-sub">
                  {description ??
                    "Re-pull a date from Shopify, Paysight & Phoenix into the database."}
                </div>
              </div>
              <button
                type="button"
                className="sync-modal-close"
                onClick={() => !running && setOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>

            <div className="sync-modal-body">
              <div className="sync-mode-toggle">
                <button
                  type="button"
                  className={`sync-seg ${mode === "single" ? "active" : ""}`}
                  onClick={() => setMode("single")}
                  disabled={running}
                >
                  Single date
                </button>
                <button
                  type="button"
                  className={`sync-seg ${mode === "range" ? "active" : ""}`}
                  onClick={() => setMode("range")}
                  disabled={running}
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
                    disabled={running}
                  />
                </label>
              ) : (
                <div className="sync-field-row">
                  <label className="sync-field">
                    <span>From</span>
                    <input
                      type="date"
                      value={from}
                      max={todayUtc()}
                      onChange={(e) => setFrom(e.target.value)}
                      disabled={running}
                    />
                  </label>
                  <label className="sync-field">
                    <span>To</span>
                    <input
                      type="date"
                      value={to}
                      max={todayUtc()}
                      onChange={(e) => setTo(e.target.value)}
                      disabled={running}
                    />
                  </label>
                </div>
              )}

              <p className="sync-note">
                Max 31 days.{" "}
                {phoenixRevenue
                  ? "Phoenix subscription revenue is heavy — for wide ranges it may need a second run to finish."
                  : "Pulls the latest Paysight transactions and Phoenix subscriber counts."}
              </p>

              {running ? (
                <div className="sync-progress">
                  <div className="sync-progress-bar">
                    <div
                      className="sync-progress-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="sync-progress-meta">
                    <span className="sync-progress-phase">{phase}</span>
                    <span className="sync-progress-pct">{pct}%</span>
                  </div>
                </div>
              ) : null}

              {error ? (
                <div className="sync-result err">
                  <AlertCircle size={14} /> {error}
                </div>
              ) : null}

              {result ? (
                <div className="sync-result ok">
                  <div className="sync-result-head">
                    <CheckCircle2 size={14} /> Synced {result.from}
                    {result.to && result.to !== result.from
                      ? ` → ${result.to}`
                      : ""}{" "}
                    ({result.days} day{result.days === 1 ? "" : "s"},{" "}
                    {Math.round((result.elapsedMs ?? 0) / 1000)}s)
                  </div>
                  <ul className="sync-result-list">
                    {result.shopify ? (
                      <li>
                        🛍️ Shopify: {result.shopify.orders} orders
                        {result.shopify.failed
                          ? ` · ${result.shopify.failed} failed`
                          : ""}
                      </li>
                    ) : null}
                    {result.paysight && "tx" in result.paysight ? (
                      <li>
                        💳 Paysight: {result.paysight.tx} tx ·{" "}
                        {result.paysight.subs} subs
                      </li>
                    ) : null}
                    {result.phoenix && "revenueWalk" in result.phoenix ? (
                      <li>
                        📞 Phoenix: {result.phoenix.revenueWalk}
                        {result.phoenix.activeSubscribers != null
                          ? ` · ${result.phoenix.activeSubscribers} active subs`
                          : ""}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>

            <footer className="sync-modal-foot">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setOpen(false)}
                disabled={running}
              >
                {result ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={runSync}
                disabled={running}
              >
                {running ? (
                  <>
                    <Loader2 size={13} className="spin" />
                    Syncing… {pct}%
                  </>
                ) : (
                  <>
                    <RefreshCw size={13} strokeWidth={2} />
                    {result ? "Sync again" : "Sync now"}
                  </>
                )}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}

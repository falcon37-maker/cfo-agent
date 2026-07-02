"use client";

// Shown right after a PDF upload: a preview of EVERYTHING the AI extracted
// (summary + every transaction) before it touches the Overview. Confirm applies
// it to the fields; Cancel discards it. Rendered only while a preview exists.

import { useFormStatus } from "react-dom";
import { Check, X, Loader2, FileText } from "lucide-react";
import { fmtMoney, fmtInt } from "@/lib/format";
import type { PdfSummary } from "@/lib/zoho/labels";
import { confirmPdfAction, cancelPdfAction } from "@/app/(shell)/finance/actions";

type Txn = {
  date: string;
  description: string;
  amount: number;
  debit_or_credit: string;
  category: string;
};

function ConfirmBtn() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="primary-btn" disabled={pending}>
      {pending ? (
        <>
          <Loader2 size={13} className="spin" /> Applying…
        </>
      ) : (
        <>
          <Check size={13} strokeWidth={2.5} /> Confirm &amp; show
        </>
      )}
    </button>
  );
}

function CancelBtn() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="ghost-btn" disabled={pending}>
      Cancel
    </button>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="card" style={{ padding: "12px 14px", flex: "1 1 0%", minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export function PdfPreviewModal({ summary, txns }: { summary: PdfSummary; txns: Txn[] }) {
  return (
    <div className="sync-modal-root">
      <div className="sync-modal-backdrop" />
      <div
        className="sync-modal"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 760, width: "94vw" }}
      >
        <header className="sync-modal-head">
          <div>
            <div className="sync-modal-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FileText size={15} style={{ color: "var(--accent)" }} />
              Preview — {summary.fileName ?? "statement"}
            </div>
            <div className="sync-modal-sub">
              {fmtInt(summary.count)} transactions extracted. Review below, then
              confirm to show this on your Overview.
            </div>
          </div>
        </header>

        <div className="sync-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <Kpi label="Gross Revenue" value={fmtMoney(summary.grossRevenue)} />
            <Kpi label="Total Fees & Deductions" value={fmtMoney(summary.totalFees)} color="var(--negative)" />
            <Kpi
              label="Net"
              value={fmtMoney(summary.net)}
              color={summary.net >= 0 ? "var(--accent)" : "var(--negative)"}
            />
          </div>

          <div
            className="card table-card pnl-ledger-themed"
            style={{ borderRadius: 12, maxHeight: 320, overflow: "auto" }}
          >
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Amount</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{t.date || "—"}</td>
                    <td
                      style={{
                        maxWidth: 240,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={t.description}
                    >
                      {t.description}
                    </td>
                    <td
                      className="num"
                      style={{
                        color: t.debit_or_credit === "debit" ? "var(--accent)" : "var(--negative)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.debit_or_credit === "debit" ? "+" : "−"}
                      {fmtMoney(t.amount)}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{t.category}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="sync-modal-foot">
          <form action={cancelPdfAction}>
            <CancelBtn />
          </form>
          <form action={confirmPdfAction}>
            <ConfirmBtn />
          </form>
        </footer>
      </div>
    </div>
  );
}

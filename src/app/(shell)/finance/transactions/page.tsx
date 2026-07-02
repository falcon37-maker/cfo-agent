// /finance/transactions — AI bookkeeping review queue (Finance ▸ Bookkeeping
// tab). Pulls uncategorized bank transactions from Zoho, the AI suggests a
// category for each (dry-run, staged in transaction_labels), and the reviewer
// confirms (writes the category back to Zoho) or rejects. Nothing hits Zoho
// until confirm.

import { requireTenant } from "@/lib/tenant";
import { listStagedLabels, countsByStatus } from "@/lib/zoho/labels";
import { listBankAccounts } from "@/lib/zoho/transactions";
import { LabelTable } from "@/components/finance/LabelTable";
import { Landmark } from "lucide-react";
import { SyncFromZohoButton } from "@/components/finance/SyncFromZohoButton";
import { FlashBanner } from "@/components/finance/FlashBanner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transaction Labeling — CFO Agent" };

export default async function FinanceTransactionsPage() {
  const tenant = await requireTenant();
  const [rows, counts, accounts] = await Promise.all([
    listStagedLabels(tenant.id), // suggested + confirmed + rejected
    countsByStatus(tenant.id),
    listBankAccounts(tenant.id).catch(() => []),
  ]);
  // account_id → last 4 of the masked account number, for a clearer label.
  const accountNumbers: Record<string, string> = {};
  for (const a of accounts) {
    const last4 = (a.account_number ?? "").replace(/\D/g, "").slice(-4);
    if (last4) accountNumbers[a.account_id] = last4;
  }

  return (
    <div className="dashboard-narrow">
      <div className="pnl-header" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 0%", minWidth: 0 }}>
          <div className="greet-eyebrow">Finance · Transaction Labeling</div>
          <h1 className="greet-title">
            <Landmark size={18} strokeWidth={2} /> AI Transaction Labeling
          </h1>
          <div className="section-sub" style={{ marginTop: 4 }}>
            Sync pulls transactions from Zoho and the AI categorizes each.
            &ldquo;Accept&rdquo; writes the category into Zoho Books. (
            {counts.suggested} pending · {counts.applied} in Zoho ·{" "}
            {counts.rejected} rejected)
          </div>
        </div>
        <div style={{ flexShrink: 0, display: "flex", gap: 8 }}>
          <SyncFromZohoButton />
        </div>
      </div>

      {/* ── Feedback banner (client-side, auto-dismiss, never sticks on refresh) ── */}
      <FlashBanner />

      {/* ── Review queue ── */}
      {rows.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
          No transactions waiting for review.
          <div style={{ marginTop: 10, fontSize: 11.5 }}>
            Click <strong>Run AI labeling</strong> to pull uncategorized
            transactions from Zoho and have the AI suggest categories.
          </div>
        </div>
      ) : (
        <>
          <div className="section-eyebrow">Review queue</div>
          <LabelTable rows={rows} accountNumbers={accountNumbers} />
        </>
      )}
    </div>
  );
}

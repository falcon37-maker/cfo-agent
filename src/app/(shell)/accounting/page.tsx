import { ComingSoon } from "@/components/shell/ComingSoon";

export default function AccountingPage() {
  return (
    <ComingSoon
      phase="Phase C · needs QuickBooks + Plaid integrations"
      needs={[
        "QuickBooks Online sync (monthly P&L grid, expense categories)",
        "Plaid bank reconciliation (matched / unmatched / flagged)",
        "Integration sync status cards (QB, Stripe·Phoenix, Shopify, Plaid)",
      ]}
    />
  );
}

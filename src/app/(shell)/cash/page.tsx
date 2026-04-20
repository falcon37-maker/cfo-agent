import { ComingSoon } from "@/components/shell/ComingSoon";

export default function CashPage() {
  return (
    <ComingSoon
      phase="Phase C · needs Plaid bank integration"
      needs={[
        "Plaid connection for current cash position + operating / reserve split",
        "Scenario projection chart with daily-new-subs + churn-rate sliders",
        "Break-even bar (current MRR vs target MRR)",
      ]}
    />
  );
}

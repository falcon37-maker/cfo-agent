import { ComingSoon } from "@/components/shell/ComingSoon";

export default function SubscriptionsPage() {
  return (
    <ComingSoon
      phase="Phase C · needs Phoenix billing integration"
      needs={[
        "Phoenix Billing API connection (subscription events, cancellations, salvage)",
        "Retention curve, cohort heatmap, new-vs-cancelled flow, CAC/LTV",
      ]}
    />
  );
}

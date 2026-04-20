import { ComingSoon } from "@/components/shell/ComingSoon";

export default function IntegrationsSettingsPage() {
  return (
    <ComingSoon
      phase="Phase A · next pass"
      needs={[
        "Shopify connection status per store (NOVA connected; NURA 401; KOVA 404 — domain needs fixing)",
        "Meta Ads, TikTok Ads (Phase B ad-spend connectors)",
        "QuickBooks Online, Phoenix Billing, Plaid (Phase C)",
      ]}
    />
  );
}

import { ComingSoon } from "@/components/shell/ComingSoon";

export default function CogsSettingsPage() {
  return (
    <ComingSoon
      phase="Phase A · next pass"
      needs={[
        "Import products catalog from Shopify into the existing `products` table",
        "Inline-editable per-SKU COGS cell (commits on blur/Enter, recomputes margin)",
        "Margin status pill (Healthy ≥70%, Watch 55–69%, Low <55%)",
      ]}
    />
  );
}

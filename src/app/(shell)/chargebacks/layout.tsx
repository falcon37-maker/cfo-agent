import { CbTabs } from "@/components/chargebacks/CbTabs";

export const dynamic = "force-dynamic";

export default function ChargebacksLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <CbTabs />
      {children}
    </>
  );
}

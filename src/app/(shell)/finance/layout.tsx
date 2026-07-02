import { FinanceTabs } from "@/components/finance/FinanceTabs";

export const dynamic = "force-dynamic";

export default function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <FinanceTabs />
      {children}
    </>
  );
}

import { SubsTabs } from "@/components/subscriptions/SubsTabs";

export const dynamic = "force-dynamic";

export default function SubscriptionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SubsTabs />
      {children}
    </>
  );
}

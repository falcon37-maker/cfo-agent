import { SubsSearchProvider } from "@/components/subscriptions/SubsTableSearch";

export const dynamic = "force-dynamic";

export default function SubscriptionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="subs-page">
      <SubsSearchProvider>{children}</SubsSearchProvider>
    </div>
  );
}

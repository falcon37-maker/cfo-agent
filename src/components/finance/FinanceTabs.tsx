"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Landmark, Sparkles } from "lucide-react";

const TABS = [
  { href: "/finance", label: "Overview", Icon: Landmark, exact: true },
  {
    href: "/finance/transactions",
    label: "Transaction Labeling",
    Icon: Sparkles,
    exact: false,
  },
];

export function FinanceTabs() {
  const pathname = usePathname();
  const onTransactions = pathname?.startsWith("/finance/transactions");

  return (
    <div
      role="tablist"
      aria-label="Finance sections"
      style={{
        display: "flex",
        gap: 4,
        marginBottom: 16,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {TABS.map(({ href, label, Icon, exact }) => {
        const active = exact ? !onTransactions : onTransactions;
        return (
          <Link
            key={href}
            href={href}
            role="tab"
            aria-selected={active}
            prefetch={false}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 500,
              color: active ? "var(--text)" : "var(--muted-strong)",
              background: "transparent",
              borderBottom: active
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              marginBottom: -1,
              textDecoration: "none",
            }}
          >
            <Icon size={14} strokeWidth={2} />
            {label}
          </Link>
        );
      })}
    </div>
  );
}

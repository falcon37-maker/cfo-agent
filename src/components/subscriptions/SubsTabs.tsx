"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Database } from "lucide-react";

const TABS = [
  { href: "/subscriptions", label: "Overview", Icon: LayoutGrid, exact: true },
  {
    href: "/subscriptions/data-center",
    label: "Data Center",
    Icon: Database,
    exact: false,
  },
];

export function SubsTabs() {
  const pathname = usePathname();
  const isDataCenter = pathname?.startsWith("/subscriptions/data-center");

  return (
    <div
      role="tablist"
      aria-label="Subscriptions sections"
      style={{
        display: "flex",
        gap: 4,
        marginBottom: 16,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {TABS.map(({ href, label, Icon, exact }) => {
        const active = exact ? !isDataCenter : isDataCenter;
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

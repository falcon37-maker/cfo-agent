"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ShieldAlert } from "lucide-react";

const TABS = [
  { href: "/chargebacks", label: "Alerts", Icon: Bell, exact: true },
  {
    href: "/chargebacks/disputes",
    label: "Chargebacks",
    Icon: ShieldAlert,
    exact: false,
  },
];

export function CbTabs() {
  const pathname = usePathname();
  const isDisputes = pathname?.startsWith("/chargebacks/disputes");

  return (
    <div
      role="tablist"
      aria-label="Chargebacks sections"
      style={{
        display: "flex",
        gap: 4,
        marginBottom: 16,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {TABS.map(({ href, label, Icon, exact }) => {
        const active = exact ? !isDisputes : isDisputes;
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

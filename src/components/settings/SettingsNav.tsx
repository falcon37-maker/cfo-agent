"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings", label: "Stores", exact: true },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/cogs", label: "Product COGS" },
  { href: "/settings/rules", label: "Rules & Alerts" },
];

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`settings-nav-item ${isActive(pathname, item.href, item.exact) ? "active" : ""}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

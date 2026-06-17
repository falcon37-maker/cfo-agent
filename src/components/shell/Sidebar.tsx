"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  LineChart,
  Repeat,
  Settings,
  Search,
  LogOut,
  Calculator,
  CheckSquare,
  Megaphone,
  ShieldAlert,
  Landmark,
  DollarSign,
} from "lucide-react";
import { signOutAction } from "@/app/login/actions";
import type { Role } from "@/lib/auth/roles";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  /** If set, only these roles see the item. Default: visible to all. */
  roles?: Role[];
};

type NavSection = { label: string; items: NavItem[] };

// Grouped like Paysight's sidebar (Platform / Configuration / Support).
const NAV_SECTIONS: NavSection[] = [
  {
    label: "Platform",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/pnl", label: "Stores", icon: LineChart },
      { href: "/subscriptions", label: "Subscriptions", icon: Repeat },
      { href: "/finance", label: "Finance", icon: Landmark },
      { href: "/chargebacks", label: "Chargebacks", icon: ShieldAlert },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/calculator", label: "Calculator", icon: Calculator },
      { href: "/cogs", label: "Log COGS", icon: CheckSquare },
      { href: "/ads", label: "Log Ad Spend", icon: Megaphone, roles: ["admin"] },
      { href: "/revenue", label: "Log Revenue", icon: DollarSign, roles: ["admin"] },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/settings", label: "Settings", icon: Settings, roles: ["admin"] },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

function initialsFromEmail(email: string | null): string {
  if (!email) return "·";
  const local = email.split("@")[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export function Sidebar({
  userEmail,
  userId: _userId,
  role,
}: {
  userEmail: string | null;
  userId: string | null;
  role: Role;
}) {
  const pathname = usePathname();
  const visibleSections = NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((n) => !n.roles || n.roles.includes(role)),
  })).filter((s) => s.items.length > 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-mark">
          <LineChart size={18} strokeWidth={2.5} />
        </div>
        <div>
          <div className="logo-title">CFO Agent</div>
          <div className="logo-sub">Finance OS</div>
        </div>
      </div>

      <button type="button" className="sidebar-search">
        <Search size={14} />
        <span>Search or ask agent</span>
        <kbd>⌘K</kbd>
      </button>

      <nav className="sidebar-nav">
        {visibleSections.map((section) => (
          <div key={section.label} className="sidebar-group">
            <div className="sidebar-section-label">{section.label}</div>
            {section.items.map(({ href, label, icon: Icon, badge }) => {
              const active = isActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`nav-item ${active ? "active" : ""}`}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  <span>{label}</span>
                  {badge ? <span className="nav-badge">{badge}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="agent-card">
          <div className="agent-pulse"><span /></div>
          <div>
            <div className="agent-title">All systems normal</div>
            <div className="agent-sub">Phase 1 · manual sync</div>
          </div>
        </div>
        <div className="user-row">
          <div className="avatar">{initialsFromEmail(userEmail)}</div>
          <div className="user-info">
            <div className="user-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {userEmail ?? "Signed out"}
            </div>
            <div className="user-role">Falcon 37</div>
          </div>
          <form action={signOutAction} style={{ display: "flex" }}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              style={{
                background: "transparent",
                border: 0,
                color: "var(--muted)",
                cursor: "pointer",
                padding: 4,
                display: "grid",
                placeItems: "center",
              }}
            >
              <LogOut size={14} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

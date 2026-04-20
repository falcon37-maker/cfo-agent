"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  LineChart,
  Repeat,
  Banknote,
  FileSpreadsheet,
  Settings,
  Search,
  LogOut,
  Calculator,
} from "lucide-react";
import { signOutAction } from "@/app/login/actions";

const NAV: Array<{
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
}> = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pnl", label: "P&L", icon: LineChart },
  { href: "/subscriptions", label: "Subscriptions", icon: Repeat },
  { href: "/cash", label: "Cash Flow", icon: Banknote },
  { href: "/accounting", label: "Accounting", icon: FileSpreadsheet },
  { href: "/calculator", label: "Calculator", icon: Calculator },
  { href: "/settings", label: "Settings", icon: Settings },
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
}: {
  userEmail: string | null;
  userId: string | null;
}) {
  const pathname = usePathname();

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

      <div className="sidebar-section-label">Workspace</div>
      <nav className="sidebar-nav">
        {NAV.map(({ href, label, icon: Icon, badge }) => {
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

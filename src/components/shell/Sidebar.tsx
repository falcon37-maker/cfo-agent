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
  ChevronDown,
  Calculator,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pnl", label: "P&L", icon: LineChart },
  { href: "/subscriptions", label: "Subscriptions", icon: Repeat, badge: "47" },
  { href: "/cash", label: "Cash Flow", icon: Banknote },
  { href: "/accounting", label: "Accounting", icon: FileSpreadsheet },
  { href: "/calculator", label: "Calculator", icon: Calculator },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Sidebar() {
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
            <div className="agent-title">Agent is watching</div>
            <div className="agent-sub">3 flags today · auto-sync 2m ago</div>
          </div>
        </div>
        <div className="user-row">
          <div className="avatar">JG</div>
          <div className="user-info">
            <div className="user-name">Joe Gomez</div>
            <div className="user-role">Founder · 3 stores</div>
          </div>
          <ChevronDown size={14} />
        </div>
      </div>
    </aside>
  );
}

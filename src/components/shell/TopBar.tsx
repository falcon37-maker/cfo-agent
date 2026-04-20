"use client";

import { usePathname } from "next/navigation";
import { Calendar, RefreshCw, Share2 } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";

const TITLES: Record<string, { title: string; crumb: string; sub?: string }> = {
  "/": { title: "Dashboard", crumb: "Dashboard" },
  "/pnl": { title: "P&L", crumb: "P&L" },
  "/subscriptions": { title: "Subscriptions", crumb: "Subscriptions" },
  "/cash": { title: "Cash Flow", crumb: "Cash Flow" },
  "/accounting": { title: "Accounting", crumb: "Accounting" },
  "/calculator": { title: "Unit Economics Calculator", crumb: "Calculator" },
  "/settings": { title: "Settings", crumb: "Settings" },
};

function titleFor(pathname: string) {
  if (TITLES[pathname]) return TITLES[pathname];
  // nested settings etc.
  const top = "/" + pathname.split("/").filter(Boolean)[0];
  return TITLES[top] ?? { title: "CFO Agent", crumb: "" };
}

export function TopBar() {
  const pathname = usePathname();
  const { title, crumb } = titleFor(pathname);
  const now = new Date();
  const dateSub = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
    hour12: false,
  }).format(now);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="crumbs">
          <span>Workspace</span>
          <span className="sep">/</span>
          <span>Finance</span>
          <span className="sep">/</span>
          <span className="cur">{crumb || title}</span>
        </div>
        <h1 className="page-title">
          {title}
          {pathname === "/" ? <span className="page-sub">· {dateSub} ET</span> : null}
        </h1>
      </div>
      <div className="topbar-right">
        <div className="date-pill">
          <Calendar size={13} />
          <span>Last 30 days</span>
        </div>
        <ThemeToggle />
        <button type="button" className="icon-btn" aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Share">
          <Share2 size={14} />
        </button>
      </div>
    </header>
  );
}

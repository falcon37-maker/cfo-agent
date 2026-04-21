"use client";

import { usePathname, useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";

const TITLES: Record<string, { title: string; crumb: string; sub?: string }> = {
  "/": { title: "Dashboard", crumb: "Dashboard" },
  "/pnl": { title: "P&L · Shopify", crumb: "P&L" },
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
  const router = useRouter();
  const { title, crumb } = titleFor(pathname);
  // On /, the page renders its own greeting + timestamp — so we suppress the
  // TopBar title and show only the breadcrumb.
  const isDashboard = pathname === "/";

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
        {isDashboard ? null : <h1 className="page-title">{title}</h1>}
      </div>
      <div className="topbar-right">
        <ThemeToggle />
        <button
          type="button"
          className="icon-btn"
          aria-label="Refresh data"
          title="Refresh"
          onClick={() => router.refresh()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
    </header>
  );
}

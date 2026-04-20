"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LineChart, CheckSquare, Megaphone } from "lucide-react";
import { signOutAction } from "@/app/login/actions";

type NavItem = { id: string; label: string; href: string; icon: React.ElementType };

const ALL_NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/", icon: LineChart },
  { id: "cogs", label: "Log COGS", href: "/cogs", icon: CheckSquare },
  { id: "ad", label: "Log Ad Spend", href: "/ads", icon: Megaphone },
];

export function EntryShell({
  title,
  sub,
  userEmail,
  role,
  children,
}: {
  title: string;
  sub: string;
  userEmail: string | null;
  role: "admin" | "manager";
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Managers only see the Log COGS nav item — that's all they can access.
  const nav = role === "manager" ? ALL_NAV.filter((n) => n.id === "cogs") : ALL_NAV;

  const initials = userEmail
    ? userEmail.split("@")[0].slice(0, 2).toUpperCase()
    : "·";

  return (
    <div className="entry-shell">
      <header className="entry-top">
        <Link className="entry-brand" href={role === "manager" ? "/cogs" : "/"}>
          <div
            className="logo-mark"
            style={{ width: 30, height: 30, borderRadius: 8 }}
          >
            <LineChart size={16} strokeWidth={2.5} />
          </div>
          <div>
            <div className="auth-brand-name" style={{ fontSize: 13 }}>
              CFO Agent
            </div>
            <div className="auth-brand-sub" style={{ fontSize: 10.5 }}>
              Finance OS
            </div>
          </div>
        </Link>

        <nav className="entry-nav">
          {nav.map(({ id, label, href, icon: Icon }) => {
            const active =
              (href === "/" && pathname === "/") ||
              (href !== "/" && (pathname === href || pathname.startsWith(href + "/")));
            return (
              <Link
                key={id}
                href={href}
                className={`entry-nav-item ${active ? "active" : ""}`}
              >
                <Icon size={14} strokeWidth={1.8} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="entry-user">
          {userEmail ? (
            <span className="entry-user-email">{userEmail}</span>
          ) : null}
          <div className="avatar" title={userEmail ?? ""}>
            {initials}
          </div>
          <form action={signOutAction} style={{ display: "flex" }}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="ghost-btn"
              style={{ padding: "5px 10px" }}
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="entry-page">
        <div className="pnl-header">
          <div>
            <div className="crumbs">
              <Link href={role === "manager" ? "/cogs" : "/"} style={{ color: "inherit", textDecoration: "none" }}>
                Workspace
              </Link>
              <span className="sep">/</span>
              <span>Finance</span>
              <span className="sep">/</span>
              <span className="cur">{title}</span>
            </div>
            <h2 className="section-title" style={{ marginTop: 6 }}>
              {title}
            </h2>
            <div className="section-sub">{sub}</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

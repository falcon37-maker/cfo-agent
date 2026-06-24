"use client";

// Collapsible sidebar shell. Holds the collapsed state (persisted to
// localStorage) and renders the .app grid wrapper, toggling a
// `sidebar-collapsed` class. The top-bar toggle button (SidebarToggle) flips
// it via context — like the panel-collapse control on paysight.io. Pure
// UI/navigation; no data involved.
//
// State lives in a tiny external store read via useSyncExternalStore so the
// persisted value hydrates cleanly (no setState-in-effect, no mismatch).

import { createContext, useContext, useSyncExternalStore } from "react";
import { PanelLeft } from "lucide-react";

const STORAGE_KEY = "cfo:sidebar-collapsed";
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

function setCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

type SidebarCtx = { collapsed: boolean; toggle: () => void };
const Ctx = createContext<SidebarCtx>({ collapsed: false, toggle: () => {} });

export function useSidebar(): SidebarCtx {
  return useContext(Ctx);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <Ctx.Provider value={{ collapsed, toggle: () => setCollapsed(!getSnapshot()) }}>
      <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** Top-bar button that collapses / expands the sidebar. */
export function SidebarToggle() {
  const { collapsed, toggle } = useSidebar();
  return (
    <button
      type="button"
      className="icon-btn sidebar-toggle"
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-pressed={collapsed}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      <PanelLeft size={16} />
    </button>
  );
}

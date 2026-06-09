"use client";

// Settings → Stores. Renders the grid of store cards, hosts the side-
// drawer for create/edit, and runs live token-validity checks against
// /api/stores/test-connection on first paint + on demand.
//
// Why the redesign:
//   - Inline expand was forcing the form into a narrow card slot — drawer
//     gives the form room to breathe.
//   - Old status pill couldn't distinguish "no creds at all" from "creds
//     present but token revoked", so users couldn't tell whether to add a
//     token or fix the existing one. New live check disambiguates.
//   - Each card now deeplinks to /pnl?store=<code>&range=30d so users can
//     jump straight to the per-store order list.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Plus,
  Pencil,
  ListOrdered,
  RefreshCw,
  Loader2,
  X,
} from "lucide-react";
import { fmtMoney } from "@/lib/format";
import { StoreFormBody, type StoreEditValues } from "./StoreForm";

export type StoreCard = {
  id: string;
  name: string;
  domain: string | null;
  store_type: "shopify" | "manual";
  is_active: boolean;
  currency: string;
  timezone: string;
  processing_fee_pct: number | null;
  processing_fee_fixed: number | null;
  todayRevenue: number;
  sharePct: number;
  credSource: "db" | "env" | "none";
  shopify_client_id: string | null;
  has_static_token: boolean;
  has_oauth_secret: boolean;
};

// Possible runtime statuses returned by /api/stores/test-connection.
type LiveStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; shopName?: string; tz?: string; currency?: string; credSource?: string }
  | { state: "invalid"; detail?: string }
  | { state: "missing" }
  | { state: "error"; detail?: string };

export function StoresGrid({ cards }: { cards: StoreCard[] }) {
  const [drawer, setDrawer] = useState<{
    mode: "create" | "edit";
    initial?: StoreEditValues;
  } | null>(null);

  // Live connection status per store. We auto-test on first mount for any
  // Shopify store that has credentials available — that's the only way to
  // surface a token-revoked state on the card without the user clicking.
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>(
    Object.fromEntries(cards.map((c) => [c.id, { state: "idle" }])),
  );

  useEffect(() => {
    let cancelled = false;
    const initial = cards.filter(
      (c) => c.store_type === "shopify" && c.credSource !== "none" && c.is_active,
    );
    setStatuses((prev) => {
      const next = { ...prev };
      for (const c of initial) next[c.id] = { state: "checking" };
      return next;
    });
    void Promise.all(
      initial.map(async (c) => {
        try {
          const r = await fetch("/api/stores/test-connection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ storeId: c.id }),
          });
          const data = await r.json();
          if (cancelled) return;
          setStatuses((prev) => ({ ...prev, [c.id]: mapResponse(data) }));
        } catch (e) {
          if (cancelled) return;
          setStatuses((prev) => ({
            ...prev,
            [c.id]: { state: "error", detail: (e as Error).message },
          }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
    // Re-run only when the set of store IDs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.map((c) => c.id).join(",")]);

  async function recheck(id: string) {
    setStatuses((prev) => ({ ...prev, [id]: { state: "checking" } }));
    try {
      const r = await fetch("/api/stores/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId: id }),
      });
      const data = await r.json();
      setStatuses((prev) => ({ ...prev, [id]: mapResponse(data) }));
    } catch (e) {
      setStatuses((prev) => ({
        ...prev,
        [id]: { state: "error", detail: (e as Error).message },
      }));
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Stores</div>
            <div className="card-sub">
              {cards.length} configured · revenue share based on the most
              recent day with data
            </div>
          </div>
          <div className="card-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={() => setDrawer({ mode: "create" })}
            >
              <Plus size={13} strokeWidth={2} />
              Add store
            </button>
          </div>
        </div>

        <div className="stores-grid-v2">
          {cards.map((c) => (
            <StoreCardView
              key={c.id}
              card={c}
              status={statuses[c.id] ?? { state: "idle" }}
              onEdit={() =>
                setDrawer({
                  mode: "edit",
                  initial: cardToEdit(c),
                })
              }
              onRetest={() => recheck(c.id)}
            />
          ))}
        </div>
      </div>

      {drawer ? (
        <Drawer
          title={
            drawer.mode === "create" ? "Add store" : `Edit ${drawer.initial?.id}`
          }
          subtitle={
            drawer.mode === "create"
              ? "Code becomes the store ID — uppercase A-Z + 0-9 + _, max 16 chars."
              : "Empty cred fields are kept unchanged."
          }
          onClose={() => setDrawer(null)}
        >
          <StoreFormBody mode={drawer.mode} initial={drawer.initial} />
        </Drawer>
      ) : null}
    </>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────

function StoreCardView({
  card,
  status,
  onEdit,
  onRetest,
}: {
  card: StoreCard;
  status: LiveStatus;
  onEdit: () => void;
  onRetest: () => void;
}) {
  const pill = pillFor(card, status);
  const isManual = card.store_type === "manual";
  return (
    <div className={`store-card-v2${!card.is_active ? " inactive" : ""}`}>
      <div className="store-card-head">
        <div className="letter-tile">{card.id.charAt(0)}</div>
        <span className={`status-pill ${pill.tone}`} title={pill.title}>
          <span className="dot" />
          {pill.label}
        </span>
      </div>

      <div className="store-name">{card.name}</div>
      <div className="store-url">
        {card.domain ?? <span className="muted">No domain</span>}
      </div>

      <div className="store-divider" />

      <div className="store-meta">
        <div>
          <div className="sm-label">Today&apos;s revenue</div>
          <div className="sm-val">{fmtMoney(card.todayRevenue)}</div>
        </div>
        <div>
          <div className="sm-label">Share</div>
          <div className="sm-val" style={{ color: "var(--accent)" }}>
            {card.sharePct.toFixed(0)}%
          </div>
        </div>
      </div>

      <div className="store-acct">
        {card.currency} · {card.timezone} · fees{" "}
        {((card.processing_fee_pct ?? 0) * 100).toFixed(1)}%
        {card.processing_fee_fixed != null && card.processing_fee_fixed > 0
          ? ` + $${card.processing_fee_fixed.toFixed(2)}`
          : ""}
      </div>

      <div className="store-card-actions">
        <Link
          href={`/pnl?range=30d&store=${encodeURIComponent(card.id)}`}
          className="ghost-btn"
        >
          <ListOrdered size={12} strokeWidth={2} />
          View orders
        </Link>
        {!isManual && card.credSource !== "none" ? (
          <button
            type="button"
            className="ghost-btn"
            onClick={onRetest}
            disabled={status.state === "checking"}
            title="Re-test Shopify connection"
          >
            {status.state === "checking" ? (
              <Loader2 size={12} className="spin" />
            ) : (
              <RefreshCw size={12} strokeWidth={2} />
            )}
            Test
          </button>
        ) : null}
        <button type="button" className="primary-btn-sm" onClick={onEdit}>
          <Pencil size={11} strokeWidth={2} />
          Edit
        </button>
      </div>
    </div>
  );
}

// ─── Status pill mapping ──────────────────────────────────────────────

function pillFor(
  c: StoreCard,
  s: LiveStatus,
): { tone: string; label: string; title: string } {
  if (!c.is_active) {
    return {
      tone: "warn",
      label: "Inactive",
      title: "This store is excluded from cron syncs.",
    };
  }
  if (c.store_type === "manual") {
    return { tone: "neutral", label: "Manual", title: "Manual store — no API." };
  }
  if (s.state === "checking") {
    return { tone: "neutral", label: "Checking…", title: "Pinging Shopify…" };
  }
  if (s.state === "ok") {
    return {
      tone: "pos",
      label: "Connected",
      title: `Shopify reachable — shop "${s.shopName ?? ""}" (${s.tz ?? "?"} / ${s.currency ?? "?"}). Credentials from ${s.credSource ?? c.credSource}.`,
    };
  }
  if (s.state === "invalid") {
    return {
      tone: "neg",
      label: "Invalid token",
      title:
        s.detail ??
        "Shopify rejected this token (401). The token may have been revoked or copied incorrectly. Edit this store to paste a fresh token.",
    };
  }
  if (s.state === "missing") {
    return {
      tone: "warn",
      label: "Needs token",
      title: "No credentials configured. Edit this store to add a Shopify token.",
    };
  }
  if (s.state === "error") {
    return {
      tone: "warn",
      label: "Error",
      title: s.detail ?? "Unknown error while testing connection.",
    };
  }
  if (c.credSource === "none") {
    return {
      tone: "warn",
      label: "Needs token",
      title: "No credentials configured.",
    };
  }
  return {
    tone: "neutral",
    label: "Idle",
    title: "Click Test to check Shopify connection.",
  };
}

function mapResponse(data: {
  status?: string;
  credSource?: string;
  detail?: string;
  shop?: { name: string; ianaTimezone: string; currencyCode: string };
}): LiveStatus {
  switch (data.status) {
    case "ok":
      return {
        state: "ok",
        shopName: data.shop?.name,
        tz: data.shop?.ianaTimezone,
        currency: data.shop?.currencyCode,
        credSource: data.credSource,
      };
    case "invalid":
      return { state: "invalid", detail: data.detail };
    case "missing":
      return { state: "missing" };
    default:
      return { state: "error", detail: data.detail ?? "Unknown response" };
  }
}

function cardToEdit(c: StoreCard): StoreEditValues {
  return {
    id: c.id,
    name: c.name,
    store_type: c.store_type,
    shopify_domain: c.domain,
    shopify_client_id: c.shopify_client_id,
    has_static_token: c.has_static_token,
    has_oauth_secret: c.has_oauth_secret,
    credSource: c.credSource,
    processing_fee_pct: c.processing_fee_pct,
    processing_fee_fixed: c.processing_fee_fixed,
    is_active: c.is_active,
  };
}

// ─── Drawer ───────────────────────────────────────────────────────────

function Drawer({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Block page scroll while the drawer is open. Simple guard — better UX
  // than the body scrolling under a fixed-position panel.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="drawer-header">
          <div>
            <div className="drawer-title">{title}</div>
            {subtitle ? <div className="drawer-sub">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}


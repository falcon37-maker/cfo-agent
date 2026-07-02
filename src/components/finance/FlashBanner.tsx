"use client";

// One-time feedback banners (accepted / rejected / synced / error …). Rendered
// entirely client-side: on mount it reads the flash query params, shows the
// message, STRIPS the params from the URL, and auto-dismisses after a few
// seconds. Because it reads from the URL only on mount, a refresh (with the
// params already stripped) shows nothing — the banner never "sticks".

import { useEffect, useState } from "react";

type Tone = "ok" | "err" | "muted";
type Item = { text: string; tone: Tone };

const FLASH = [
  "lbl_err",
  "accepted",
  "confirmed",
  "rejected",
  "synced",
  "labeled",
  "remaining",
  "added",
  "bulk_confirmed",
  "bulk_failed",
  "bulk_remaining",
  "pdf_labeled",
];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function FlashBanner() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const p = url.searchParams;
    const out: Item[] = [];

    const err = p.get("lbl_err");
    if (err) {
      out.push({
        text:
          err === "forbidden"
            ? "You don't have permission to do that."
            : `Error: ${safeDecode(err)}`,
        tone: "err",
      });
    }
    if (p.get("accepted")) {
      out.push({ text: "✓ Accepted — categorized in Zoho Books.", tone: "ok" });
    }
    if (p.get("confirmed")) {
      out.push({ text: "Confirmed — saved to your ledger.", tone: "ok" });
    }
    if (p.get("rejected")) {
      out.push({ text: "Suggestion rejected.", tone: "muted" });
    }
    const synced = p.get("synced");
    if (synced != null) {
      out.push({
        text:
          synced === "0"
            ? "Nothing new to label — all Zoho transactions are already imported."
            : `Synced & labeled ${synced} transaction${synced === "1" ? "" : "s"} from Zoho.`,
        tone: "ok",
      });
    }
    const labeled = p.get("labeled");
    if (labeled != null) {
      out.push({
        text: `Labeled ${labeled} transaction${labeled === "1" ? "" : "s"}.`,
        tone: "ok",
      });
    }

    let changed = false;
    for (const k of FLASH) {
      if (p.has(k)) {
        p.delete(k);
        changed = true;
      }
    }
    if (changed) {
      const q = p.toString();
      window.history.replaceState(null, "", url.pathname + (q ? `?${q}` : ""));
    }

    if (out.length) {
      setItems(out);
      const t = setTimeout(() => setItems([]), 6000);
      return () => clearTimeout(t);
    }
  }, []);

  if (items.length === 0) return null;
  return (
    <>
      {items.map((it, i) => (
        <div
          key={i}
          className="card"
          style={{
            padding: 14,
            fontSize: 12.5,
            color:
              it.tone === "err"
                ? "var(--negative)"
                : it.tone === "ok"
                  ? "var(--accent)"
                  : undefined,
          }}
        >
          {it.text}
        </div>
      ))}
    </>
  );
}

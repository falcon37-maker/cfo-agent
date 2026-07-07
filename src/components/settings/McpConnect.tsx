"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — user can select manually */
        }
      }}
      title={`Copy ${label}`}
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Shows the connector URL (auto-detected from the browser's current origin)
 *  and, right after minting, the full URL with the token embedded — the form
 *  Claude Desktop's custom-connector dialog wants (URL only, no header). */
export function McpConnect({ mintedToken }: { mintedToken?: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const baseUrl = origin ? `${origin}/mcp` : "/mcp";
  const fullUrl = mintedToken
    ? `${baseUrl}?token=${mintedToken}`
    : "";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="field">
        <span className="field-label">Connector URL (base)</span>
        <div className="field-input" style={{ alignItems: "center", gap: 8 }}>
          <input type="text" readOnly value={baseUrl} className="mono" />
          <CopyButton value={baseUrl} label="URL" />
        </div>
      </div>

      {mintedToken ? (
        <>
          <div className="inline-banner banner-pos" style={{ display: "block" }}>
            <strong>Token created — copy it now, it won&apos;t be shown again.</strong>
            <div className="mono" style={{ marginTop: 6, wordBreak: "break-all" }}>
              {mintedToken}
            </div>
            <div style={{ marginTop: 8 }}>
              <CopyButton value={mintedToken} label="token" />
            </div>
          </div>

          <div className="field">
            <span className="field-label">
              Full URL for Claude Desktop (paste this in the &quot;Remote MCP server URL&quot; box)
            </span>
            <div className="field-input" style={{ alignItems: "center", gap: 8 }}>
              <input type="text" readOnly value={fullUrl} className="mono" />
              <CopyButton value={fullUrl} label="full URL" />
            </div>
            <span className="field-aside" style={{ color: "var(--muted)" }}>
              The token is included in the URL so the connector dialog (which has
              no header field) can authenticate. Keep this URL private.
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}

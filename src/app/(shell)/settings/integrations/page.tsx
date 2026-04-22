import { loadCredentials, zohoEnv } from "@/lib/zoho/tokens";
import { CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    zoho_connected?: string;
    zoho_disconnected?: string;
    zoho_error?: string;
  }>;
}) {
  const params = await searchParams;
  const creds = await loadCredentials();
  const { ORG_ID } = zohoEnv();
  const connected = Boolean(creds);
  const expiresAt = creds ? new Date(creds.expires_at) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 className="section-title">Integrations</h2>
        <div className="section-sub">
          External services the agent talks to on your behalf.
        </div>
      </div>

      {params.zoho_connected ? (
        <div className="inline-banner banner-pos">
          <CheckCircle2 size={14} strokeWidth={2} />
          Zoho Books connected.
        </div>
      ) : null}
      {params.zoho_disconnected ? (
        <div className="inline-banner banner-muted">Zoho Books disconnected.</div>
      ) : null}
      {params.zoho_error ? (
        <div className="inline-banner banner-neg">
          <AlertCircle size={14} strokeWidth={2} />
          Zoho OAuth failed: {params.zoho_error}
        </div>
      ) : null}

      <div className="integration-list card">
        <div className="integration-row">
          <div className="integration-logo">Z</div>
          <div className="integration-head">
            <div>
              <div className="integration-name">Zoho Books</div>
              <div className="integration-desc">
                Accounting source of truth · bank transactions, expenses, P&L
                reports. The Cowork agent categorizes transactions through
                this connection.
              </div>
              {connected ? (
                <div className="integration-detail">
                  Org <span className="mono">{creds?.org_id ?? ORG_ID}</span>
                  {expiresAt
                    ? ` · access token refreshes ${relTime(expiresAt)}`
                    : ""}
                </div>
              ) : (
                <div className="integration-detail">
                  Org <span className="mono">{ORG_ID || "not configured"}</span>
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {connected ? (
              <>
                <span className="status-pill status-pos">
                  <span className="pill-dot" />
                  Connected
                </span>
                <form
                  method="post"
                  action="/api/auth/zoho/disconnect"
                  style={{ display: "inline" }}
                >
                  <button type="submit" className="ghost-btn">
                    Disconnect
                  </button>
                </form>
              </>
            ) : (
              <a href="/api/auth/zoho" className="primary-btn">
                <ExternalLink size={13} strokeWidth={2} />
                Connect Zoho Books
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function relTime(target: Date): string {
  const diff = target.getTime() - Date.now();
  const mins = Math.round(diff / 60_000);
  if (mins < -60) return `expired ${Math.abs(Math.round(mins / 60))}h ago`;
  if (mins < 0) return `expired ${Math.abs(mins)}m ago`;
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}

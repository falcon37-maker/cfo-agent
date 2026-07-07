import { requireTenant } from "@/lib/tenant";
import { listTokens, listRecentCalls } from "@/lib/mcp/tokens";
import { McpConnect } from "@/components/settings/McpConnect";
import { mintTokenAction, revokeTokenAction } from "./actions";
import { Plug, Trash2, CheckCircle2, XCircle } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "MCP Connector — CFO Agent" };

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d
    .toISOString()
    .slice(11, 16)}Z`;
}

function maskToken(t: string): string {
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

export default async function McpSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ minted?: string; revoked?: string; err?: string }>;
}) {
  const params = await searchParams;
  const tenant = await requireTenant();
  const [tokens, calls] = await Promise.all([
    listTokens(tenant.id),
    listRecentCalls(tenant.id, 100),
  ]);
  const active = tokens.filter((t) => !t.revoked_at);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Plug size={16} strokeWidth={2} /> MCP Connector
        </h2>
        <div className="section-sub">
          Connect this platform to Claude Desktop / Claude.ai. Generate a token,
          paste the URL into Claude&apos;s custom connector, then ask Claude to read
          your data, label Zoho transactions, and apply them back. Everything done
          from Claude is logged below.
        </div>
      </div>

      {params.err === "forbidden" ? (
        <div className="inline-banner banner-neg">Admins only.</div>
      ) : null}
      {params.revoked ? (
        <div className="inline-banner banner-muted">Token revoked.</div>
      ) : null}

      {/* ── Connect card ── */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 14 }}>
        <div className="card-title">Connect to Claude</div>
        <McpConnect mintedToken={params.minted} />

        <form action={mintTokenAction} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="field" style={{ flex: "1 1 240px" }}>
            <span className="field-label">Connector name</span>
            <div className="field-input">
              <input type="text" name="label" placeholder="e.g. My Claude Desktop" />
            </div>
          </label>
          <button type="submit" className="primary-btn">
            <Plug size={13} strokeWidth={2} /> Generate token
          </button>
        </form>

        <div className="section-sub" style={{ fontSize: 11.5, color: "var(--muted)" }}>
          In Claude: Settings → Connectors → Add custom connector → paste the{" "}
          <strong>Full URL</strong> (shown after you generate a token) into the
          &quot;Remote MCP server URL&quot; box. Leave OAuth fields empty.
        </div>
      </div>

      {/* ── Active tokens ── */}
      <div>
        <div className="section-eyebrow">Tokens</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Token</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tokens.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 20 }}>
                      No tokens yet. Generate one above.
                    </td>
                  </tr>
                ) : (
                  tokens.map((t) => (
                    <tr key={t.token}>
                      <td>{t.label ?? "—"}</td>
                      <td className="mono muted" style={{ fontSize: 11 }}>{maskToken(t.token)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{fmtWhen(t.created_at)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{fmtWhen(t.last_used_at)}</td>
                      <td style={{ color: t.revoked_at ? "var(--negative)" : "var(--accent)", fontWeight: 600 }}>
                        {t.revoked_at ? "revoked" : "active"}
                      </td>
                      <td className="num">
                        {t.revoked_at ? null : (
                          <form action={revokeTokenAction} style={{ display: "inline" }}>
                            <input type="hidden" name="token" value={t.token} />
                            <button type="submit" className="ghost-btn" title="Revoke">
                              <Trash2 size={13} strokeWidth={2} /> Revoke
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        {active.length === 0 && tokens.length > 0 ? (
          <div className="section-sub" style={{ fontSize: 11.5, marginTop: 6, color: "var(--warning, #ffb020)" }}>
            No active tokens — Claude can&apos;t connect until you generate one.
          </div>
        ) : null}
      </div>

      {/* ── Activity history ── */}
      <div>
        <div className="section-eyebrow">Activity — what Claude did</div>
        <div className="card table-card">
          <div className="table-wrap">
            <table className="pnl-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Details</th>
                  <th className="num">ms</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {calls.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 20 }}>
                      Nothing yet. Actions taken from Claude will appear here.
                    </td>
                  </tr>
                ) : (
                  calls.map((c) => (
                    <tr key={c.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{fmtWhen(c.created_at)}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{c.tool_name}</td>
                      <td
                        className="muted"
                        style={{ fontSize: 11, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={c.error ?? JSON.stringify(c.arguments ?? {})}
                      >
                        {c.error ? c.error : JSON.stringify(c.arguments ?? {})}
                      </td>
                      <td className="num muted" style={{ fontSize: 11 }}>{c.duration_ms ?? "—"}</td>
                      <td>
                        {c.ok ? (
                          <span style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <CheckCircle2 size={13} strokeWidth={2} /> ok
                          </span>
                        ) : (
                          <span style={{ color: "var(--negative)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <XCircle size={13} strokeWidth={2} /> error
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

import { loadCredentials, zohoEnv } from "@/lib/zoho/tokens";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hasStoreCreds } from "@/lib/shopify/stores";
import {
  pingChargeblastAction,
  syncChargeblastAction,
} from "./actions";
import {
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Store as StoreIcon,
  ShieldAlert,
  Zap,
  RefreshCw,
} from "lucide-react";

export const dynamic = "force-dynamic";

type ShopifyStoreRow = {
  id: string;
  name: string;
  shop_domain: string;
  is_active: boolean;
  processing_fee_pct: number | null;
  last_synced_at?: string | null;
};

async function loadShopifyStores(): Promise<ShopifyStoreRow[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select("id, name, shop_domain, is_active, processing_fee_pct")
    .eq("is_active", true)
    .neq("id", "PORTFOLIO")
    .neq("id", "__BACKFILL_DEDUPE__")
    .like("shop_domain", "%.myshopify.com")
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as ShopifyStoreRow[];
}

export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    zoho_connected?: string;
    zoho_disconnected?: string;
    zoho_error?: string;
    cb_test?: string;
    cb_sync?: string;
    cb_msg?: string;
    cb_total?: string;
    cb_seen?: string;
    cb_mapped?: string;
    cb_upserted?: string;
  }>;
}) {
  const params = await searchParams;
  const [creds, shopifyStores] = await Promise.all([
    loadCredentials(),
    loadShopifyStores(),
  ]);
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
      {params.cb_test === "ok" ? (
        <div className="inline-banner banner-pos">
          <CheckCircle2 size={14} strokeWidth={2} />
          Chargeblast reachable · {params.cb_total} alerts visible.
        </div>
      ) : null}
      {params.cb_test === "fail" ? (
        <div className="inline-banner banner-neg">
          <AlertCircle size={14} strokeWidth={2} />
          Chargeblast ping failed: {params.cb_msg ?? "unknown error"}
        </div>
      ) : null}
      {params.cb_sync === "ok" ? (
        <div className="inline-banner banner-pos">
          <CheckCircle2 size={14} strokeWidth={2} />
          Chargeblast synced · {params.cb_seen} seen, {params.cb_mapped} mapped,
          {" "}{params.cb_upserted} upserted.
        </div>
      ) : null}
      {params.cb_sync === "fail" ? (
        <div className="inline-banner banner-neg">
          <AlertCircle size={14} strokeWidth={2} />
          Chargeblast sync failed: {params.cb_msg ?? "unknown error"}
        </div>
      ) : null}

      {/* Zoho Books */}
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

      {/* Shopify Stores */}
      <div>
        <h3
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text)",
            margin: "8px 0 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <StoreIcon size={14} strokeWidth={2} />
          Shopify Stores
        </h3>
        <div className="section-sub" style={{ marginBottom: 10 }}>
          Stores that sync directly from Shopify (non-PHX). Revenue lands in
          the <span className="mono">shopify_revenue</span> column of the
          dashboard.
        </div>
        {/* Chargeblast section rendered at bottom */}
        <div className="integration-list card">
          {shopifyStores.length === 0 ? (
            <div
              className="integration-row"
              style={{ gridTemplateColumns: "1fr", color: "var(--muted)" }}
            >
              No Shopify stores configured yet.
            </div>
          ) : (
            shopifyStores.map((s) => {
              const credsSet = hasStoreCreds(s.id);
              return (
                <div className="integration-row" key={s.id}>
                  <div className="integration-logo">{s.id.slice(0, 1)}</div>
                  <div className="integration-head">
                    <div>
                      <div className="integration-name">{s.name}</div>
                      <div className="integration-desc">
                        <span className="mono">{s.shop_domain}</span>
                      </div>
                      <div className="integration-detail">
                        Fee <span className="mono">
                          {((s.processing_fee_pct ?? 0) * 100).toFixed(1)}%
                        </span>
                        {" · "}
                        {credsSet ? (
                          <>
                            Token set · included in daily cron
                          </>
                        ) : (
                          <>
                            <span style={{ color: "var(--warning, #ffb020)" }}>
                              Token missing — add {s.id}_DOMAIN + {s.id}_TOKEN
                              to Vercel env
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span
                      className={`status-pill ${credsSet ? "status-pos" : "status-warn"}`}
                    >
                      <span className="pill-dot" />
                      {credsSet ? "Connected" : "Needs token"}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div
          className="section-sub"
          style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)" }}
        >
          Add-store form with test-connection lands in the next pass. For now,
          drop <span className="mono">STORECODE_DOMAIN</span> +{" "}
          <span className="mono">STORECODE_TOKEN</span> into Vercel env vars
          and insert a matching row in the <span className="mono">stores</span>
          table; the daily cron picks them up automatically.
        </div>
      </div>

      {/* Chargeblast */}
      <div>
        <h3
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text)",
            margin: "8px 0 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ShieldAlert size={14} strokeWidth={2} />
          Chargeblast
        </h3>
        <div className="section-sub" style={{ marginBottom: 10 }}>
          Ethoca / CDRN chargeback alerts. Feeds the{" "}
          <a href="/chargebacks" className="mono" style={{ color: "var(--accent)" }}>
            /chargebacks
          </a>{" "}
          page.
        </div>
        <div className="integration-list card">
          <div className="integration-row">
            <div className="integration-logo">C</div>
            <div className="integration-head">
              <div>
                <div className="integration-name">Chargeblast</div>
                <div className="integration-desc">
                  Webhook URL (paste into Chargeblast dashboard):{" "}
                  <span className="mono" style={{ color: "var(--text)" }}>
                    https://app.cfo-agent.ai/api/webhooks/chargeblast
                  </span>
                </div>
                <div className="integration-detail">
                  API key status:{" "}
                  {process.env.CHARGEBLAST_API_KEY ? (
                    <span style={{ color: "var(--accent)" }}>set</span>
                  ) : (
                    <span style={{ color: "var(--warning, #ffb020)" }}>
                      set <span className="mono">CHARGEBLAST_API_KEY</span> in Vercel env
                    </span>
                  )}
                  {" · "}
                  Webhook secret:{" "}
                  {process.env.CHARGEBLAST_WEBHOOK_SECRET ? (
                    <span style={{ color: "var(--accent)" }}>set</span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>not set (live events off)</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span
                className={`status-pill ${process.env.CHARGEBLAST_API_KEY ? "status-pos" : "status-warn"}`}
              >
                <span className="pill-dot" />
                {process.env.CHARGEBLAST_API_KEY ? "Connected" : "Needs key"}
              </span>
              {process.env.CHARGEBLAST_API_KEY ? (
                <>
                  <form action={pingChargeblastAction} style={{ display: "inline" }}>
                    <button type="submit" className="ghost-btn">
                      <Zap size={13} strokeWidth={2} />
                      Test
                    </button>
                  </form>
                  <form action={syncChargeblastAction} style={{ display: "inline" }}>
                    <button type="submit" className="primary-btn">
                      <RefreshCw size={13} strokeWidth={2} />
                      Run sync
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div
          className="section-sub"
          style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)" }}
        >
          <strong>Test</strong> pings the Chargeblast API.{" "}
          <strong>Run sync</strong> pulls the last 7 days of alerts and upserts
          them — same call the daily cron makes. API key is set via{" "}
          <span className="mono">CHARGEBLAST_API_KEY</span> in Vercel env;
          rotate it there. Merchant-descriptor to store mapping lives in{" "}
          <span className="mono">stores.chargeblast_descriptor</span>.
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

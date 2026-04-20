import { Plus } from "lucide-react";
import { loadDashboardData } from "@/lib/pnl/queries";
import { fmtMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function StoresSettingsPage() {
  const data = await loadDashboardData();
  const { stores, storeMixToday } = data;
  const totalToday = storeMixToday.reduce((s, p) => s + p.revenue, 0);

  const statsByStore = new Map(storeMixToday.map((p) => [p.store, p]));

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Stores</div>
            <div className="card-sub">
              {stores.length} active · revenue share based on the most recent day with data
            </div>
          </div>
          <div className="card-actions">
            <button className="primary-btn" type="button" disabled title="Manual add coming soon">
              <Plus size={13} strokeWidth={2} />
              Add store
            </button>
          </div>
        </div>
        <div className="stores-grid">
          {stores.map((s) => {
            const mix = statsByStore.get(s.id);
            const today = mix?.revenue ?? 0;
            const share = totalToday > 0 ? (today / totalToday) * 100 : 0;
            const isShopifyAuthed = s.id === "NOVA"; // only NOVA has a working token right now
            return (
              <div key={s.id} className="store-card">
                <div className="store-head">
                  <div className="letter-tile">{s.id.charAt(0)}</div>
                  <span className={`status-pill ${isShopifyAuthed ? "pos" : "warn"}`}>
                    <span className="dot" />
                    {isShopifyAuthed ? "Connected" : "Needs attention"}
                  </span>
                </div>
                <div className="store-name">{s.name}</div>
                <div className="store-url">{s.shop_domain}</div>
                <div className="store-divider" />
                <div className="store-meta">
                  <div>
                    <div className="sm-label">Today&apos;s revenue</div>
                    <div className="sm-val">{fmtMoney(today)}</div>
                  </div>
                  <div>
                    <div className="sm-label">Share</div>
                    <div className="sm-val" style={{ color: "var(--accent)" }}>
                      {share.toFixed(0)}%
                    </div>
                  </div>
                </div>
                <div className="store-acct">
                  {s.currency} · {s.timezone} · fees {(s.processing_fee_pct * 100).toFixed(1)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

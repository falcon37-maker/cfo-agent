"use client";

import { useState } from "react";
import { Check, Send } from "lucide-react";
import { StoreSelect, type StoreOption } from "@/components/entry/StoreSelect";
import { DatePicker } from "@/components/entry/DatePicker";
import { AmountInput } from "@/components/entry/AmountInput";
import { fmtMoney, fmtDate } from "@/lib/format";
import { submitAdSpendAction } from "./actions";

type Recent = {
  id: string;
  store_id: string;
  date: string;
  amount: number;
};

const PLATFORMS = [
  { id: "meta", name: "Meta", color: "#6b7bff" },
  { id: "google", name: "Google", color: "#ffb020" },
  { id: "tiktok", name: "TikTok", color: "#ff4d5e" },
];

export function AdsForm({
  stores,
  recent,
  today,
}: {
  stores: StoreOption[];
  recent: Recent[];
  today: string;
}) {
  const [store, setStore] = useState(stores[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [platform, setPlatform] = useState("meta");
  const [parsed, setParsed] = useState(0);
  const [campaign, setCampaign] = useState("");

  const storeObj = stores.find((s) => s.id === store);
  const platObj = PLATFORMS.find((p) => p.id === platform);

  return (
    <div className="entry-grid">
      <form
        key={`ads-${parsed}`}
        action={submitAdSpendAction}
        className="card entry-card"
      >
        <input type="hidden" name="store" value={store} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="platform" value={platform} />

        <div className="card-head">
          <div>
            <div className="card-title">New ad spend entry</div>
            <div className="card-sub">One store · one platform · one day</div>
          </div>
          <span className="status-pill status-pos">
            <span className="pill-dot" />
            Draft
          </span>
        </div>

        <div className="entry-body">
          <label className="field">
            <span className="field-label">Store</span>
            <StoreSelect value={store} onChange={setStore} options={stores} />
          </label>

          <label className="field">
            <span className="field-label">Platform</span>
            <div className="plat-row">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`plat-btn ${platform === p.id ? "active" : ""}`}
                  onClick={() => setPlatform(p.id)}
                >
                  <span className="plat-dot" style={{ background: p.color }} />
                  {p.name}
                </button>
              ))}
            </div>
            <div className="field-hint">
              Platform tag is informational — all spend is currently rolled up
              into the single <strong>facebook</strong> platform key so it lands
              alongside historical CSV data.
            </div>
          </label>

          <label className="field">
            <span className="field-label">Date</span>
            <DatePicker value={date} onChange={setDate} max={today} />
          </label>

          <label className="field">
            <span className="field-label">
              Spend amount
              <span className="field-aside mono">USD</span>
            </span>
            <AmountInput name="amount" onValueChange={setParsed} />
            <div className="field-hint">
              Paste from Ads Manager —{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>$4,820.00</code>,
              commas or spaces are fine. Total {platObj?.name} spend for{" "}
              <strong>{storeObj?.name}</strong> on{" "}
              <strong>{fmtDate(date)}</strong>.
            </div>
          </label>

          <label className="field">
            <span className="field-label">
              Campaign{" "}
              <span className="field-aside" style={{ color: "var(--muted)" }}>
                optional
              </span>
            </span>
            <div className="field-input">
              <Send size={14} strokeWidth={2} />
              <input
                type="text"
                name="campaign"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
                placeholder="Spring-Retarget-03"
              />
            </div>
          </label>
        </div>

        <div className="entry-foot">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setParsed(0);
              setCampaign("");
            }}
          >
            Clear
          </button>
          <button type="submit" className="primary-btn" disabled={!parsed}>
            <Check size={13} strokeWidth={2.3} />
            Save spend entry
          </button>
        </div>
      </form>

      <aside className="entry-aside">
        <div className="preview-card">
          <div className="preview-label">Live preview</div>
          <div className="preview-row">
            <span className="plat-dot inline" style={{ background: platObj?.color }} />
            {platObj?.name} · {storeObj?.name} · {fmtDate(date)}
          </div>
          <div className="preview-big">
            {parsed
              ? `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
              : "$0.00"}
          </div>
          <div className="preview-meta">
            <div>
              <span className="pm-lbl">Feeds into</span>
              <span className="pm-val">Daily P&amp;L · ROAS · CAC</span>
            </div>
            <div>
              <span className="pm-lbl">Rule</span>
              <span className="pm-val mono">net_profit subtracts ad spend</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title small">Recent entries</div>
              <div className="card-sub">Last {recent.length} · across stores</div>
            </div>
          </div>
          <table className="pnl-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Store</th>
                <th className="num">Spend</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ textAlign: "center", color: "var(--muted)", padding: 16 }}>
                    No submissions yet.
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date)}</td>
                    <td style={{ color: "var(--text)" }}>{r.store_id}</td>
                    <td className="num">{fmtMoney(r.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}

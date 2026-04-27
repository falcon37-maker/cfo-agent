"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createStoreAction,
  updateStoreAction,
  deactivateStoreAction,
} from "@/app/(shell)/settings/stores/actions";
import { Plus, Save, Trash2, Eye, EyeOff } from "lucide-react";

export type StoreEditValues = {
  id: string;
  name: string;
  store_type: "shopify" | "manual";
  shopify_domain: string | null;
  shopify_client_id: string | null;
  has_static_token: boolean;
  has_oauth_secret: boolean;
  processing_fee_pct: number | null;
  processing_fee_fixed: number | null;
  is_active: boolean;
};

export function AddStoreToggle() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="primary-btn"
        onClick={() => setOpen(true)}
      >
        <Plus size={13} strokeWidth={2} />
        Add store
      </button>
    );
  }
  return (
    <div
      className="card"
      style={{ padding: 18, marginTop: 12, maxWidth: 720 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div>
          <div className="card-title">New store</div>
          <div className="card-sub">
            Code becomes the store ID — uppercase, A-Z + 0-9 + _, max 16
            chars.
          </div>
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      <StoreFormBody mode="create" />
    </div>
  );
}

export function StoreEditRow({ value }: { value: StoreEditValues }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="ghost-btn"
        onClick={() => setOpen(true)}
        style={{ fontSize: 11 }}
      >
        Edit
      </button>
    );
  }
  return (
    <div
      className="card"
      style={{
        padding: 16,
        gridColumn: "1 / -1",
        margin: "8px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div className="card-title">Editing {value.id}</div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      <StoreFormBody mode="edit" initial={value} />
      <form
        action={deactivateStoreAction}
        style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}
      >
        <input type="hidden" name="id" value={value.id} />
        <button
          type="submit"
          className="ghost-btn"
          style={{ color: "var(--negative)" }}
        >
          <Trash2 size={13} strokeWidth={2} />
          Deactivate store
        </button>
      </form>
    </div>
  );
}

function StoreFormBody({
  mode,
  initial,
}: {
  mode: "create" | "edit";
  initial?: StoreEditValues;
}) {
  const [type, setType] = useState<"shopify" | "manual">(
    initial?.store_type ?? "shopify",
  );
  const [showSecret, setShowSecret] = useState(false);

  return (
    <form
      action={mode === "create" ? createStoreAction : updateStoreAction}
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Code">
          <input
            type="text"
            name="id"
            required
            defaultValue={initial?.id ?? ""}
            readOnly={mode === "edit"}
            placeholder="NOVA"
            maxLength={16}
            style={{ textTransform: "uppercase" }}
          />
        </Field>
        <Field label="Display name">
          <input
            type="text"
            name="name"
            required
            defaultValue={initial?.name ?? ""}
            placeholder="Nova Sense USA"
            maxLength={120}
          />
        </Field>
      </div>

      <Field label="Store type">
        <select
          name="store_type"
          value={type}
          onChange={(e) => setType(e.target.value as "shopify" | "manual")}
        >
          <option value="shopify">Shopify</option>
          <option value="manual">Manual (no API)</option>
        </select>
      </Field>

      {type === "shopify" ? (
        <>
          <Field label="Shopify domain">
            <input
              type="text"
              name="shopify_domain"
              required
              defaultValue={initial?.shopify_domain ?? ""}
              placeholder="example-shop.myshopify.com"
            />
          </Field>
          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)" }}>
              Auth ({initial?.has_static_token
                ? "static token set"
                : initial?.has_oauth_secret
                  ? "OAuth credentials set"
                  : "not set"})
            </summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <Field label="Admin API access token (shpat_...)">
                <input
                  type={showSecret ? "text" : "password"}
                  name="shopify_token"
                  defaultValue=""
                  placeholder={
                    initial?.has_static_token
                      ? "•••••••• (leave empty to keep existing)"
                      : "shpat_..."
                  }
                />
              </Field>
              <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
                — or —
              </div>
              <Field label="Client ID (Dev Dashboard OAuth)">
                <input
                  type="text"
                  name="shopify_client_id"
                  defaultValue={initial?.shopify_client_id ?? ""}
                  placeholder="hex-client-id"
                />
              </Field>
              <Field label="Client Secret (shpss_...)">
                <input
                  type={showSecret ? "text" : "password"}
                  name="shopify_client_secret"
                  defaultValue=""
                  placeholder={
                    initial?.has_oauth_secret
                      ? "•••••••• (leave empty to keep existing)"
                      : "shpss_..."
                  }
                />
              </Field>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setShowSecret((s) => !s)}
                style={{ alignSelf: "flex-start" }}
              >
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                {showSecret ? "Hide" : "Show"} secrets
              </button>
            </div>
          </details>
        </>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Processing fee % (0–1)">
          <input
            type="number"
            step="0.001"
            min="0"
            max="1"
            name="processing_fee_pct"
            defaultValue={initial?.processing_fee_pct ?? 0.029}
            placeholder="0.029"
          />
        </Field>
        <Field label="Processing fee fixed ($)">
          <input
            type="number"
            step="0.01"
            min="0"
            name="processing_fee_fixed"
            defaultValue={initial?.processing_fee_fixed ?? 0.3}
            placeholder="0.30"
          />
        </Field>
      </div>

      <label className="check" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          name="is_active"
          defaultChecked={initial?.is_active ?? true}
        />
        <span className="check-box" />
        <span>Active (included in cron syncs)</span>
      </label>

      <SaveButton mode={mode} />
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="field-input">{children}</div>
    </label>
  );
}

function SaveButton({ mode }: { mode: "create" | "edit" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="primary-btn"
      disabled={pending}
      style={{ alignSelf: "flex-start", marginTop: 6 }}
    >
      {pending ? (
        <>
          <span className="spinner" />
          Saving…
        </>
      ) : (
        <>
          <Save size={13} strokeWidth={2} />
          {mode === "create" ? "Create store" : "Save changes"}
        </>
      )}
    </button>
  );
}

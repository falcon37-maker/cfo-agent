"use client";

// The form body for create/edit store. Rendered inside the drawer hosted
// by StoresGrid. The legacy `AddStoreToggle` / `StoreEditRow` inline-expand
// wrappers were removed in favor of the drawer, so this file only owns
// the field grid and the submit/delete actions now.

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createStoreAction,
  updateStoreAction,
  deactivateStoreAction,
} from "@/app/(shell)/settings/stores/actions";
import { Save, Trash2, Eye, EyeOff } from "lucide-react";

export type StoreEditValues = {
  id: string;
  name: string;
  store_type: "shopify" | "manual";
  shopify_domain: string | null;
  shopify_client_id: string | null;
  // Tokens themselves are NEVER sent to the client — we surface only
  // "is something stored" booleans so the form can render the correct
  // empty-vs-masked state without leaking secrets.
  has_static_token: boolean;
  has_oauth_secret: boolean;
  // Where credentials are resolved from for this store:
  //   "db"   → encrypted in stores table
  //   "env"  → CODE_DOMAIN/CODE_TOKEN env-var fallback
  //   "none" → no credentials anywhere
  // Form uses this to show a "Token stored in env" badge so editors
  // know the token works even though the input is empty (env creds
  // can't be edited from the UI — only via the .env file).
  credSource: "db" | "env" | "none";
  processing_fee_pct: number | null;
  processing_fee_fixed: number | null;
  is_active: boolean;
};

export function StoreFormBody({
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
    <div style={{ display: "grid", gap: 16 }}>
      <form
        action={mode === "create" ? createStoreAction : updateStoreAction}
        style={{ display: "grid", gap: 14 }}
      >
        <div className="form-row-2">
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

            {/* Authentication panel.
              *
              * The form NEVER pre-fills token values — we keep them
              * encrypted at rest and never send them back to the client.
              * Three states the user might be in:
              *
              *   1. DB-stored token  → show "● Token stored in database",
              *      input is empty with a masked placeholder. Submitting
              *      empty keeps the existing token; pasting a new value
              *      replaces it.
              *   2. ENV-stored token → show "● Token loaded from .env",
              *      input is disabled (can't edit env from UI).
              *   3. No token         → show "● No token configured",
              *      input is empty and ready for input.
              */}
            <div className="auth-details">
              <div className="auth-summary">
                <span>Authentication</span>
                <AuthStateBadge
                  credSource={initial?.credSource ?? "none"}
                  hasStatic={initial?.has_static_token ?? false}
                  hasOAuth={initial?.has_oauth_secret ?? false}
                />
              </div>
              <div className="auth-fields">
                <Field label="Admin API access token (shpat_…)">
                  <input
                    type={showSecret ? "text" : "password"}
                    name="shopify_token"
                    defaultValue=""
                    placeholder={
                      initial?.has_static_token
                        ? "•••••••• (saved — leave empty to keep)"
                        : "shpat_..."
                    }
                    autoComplete="off"
                  />
                  <EyeToggle
                    on={showSecret}
                    onToggle={() => setShowSecret((s) => !s)}
                  />
                </Field>
                <div className="auth-or">— or OAuth —</div>
                <Field label="Client ID (Dev Dashboard OAuth)">
                  <input
                    type="text"
                    name="shopify_client_id"
                    defaultValue={initial?.shopify_client_id ?? ""}
                    placeholder="hex-client-id"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Client Secret (shpss_…)">
                  <input
                    type={showSecret ? "text" : "password"}
                    name="shopify_client_secret"
                    defaultValue=""
                    placeholder={
                      initial?.has_oauth_secret
                        ? "•••••••• (saved — leave empty to keep)"
                        : "shpss_..."
                    }
                    autoComplete="off"
                  />
                  <EyeToggle
                    on={showSecret}
                    onToggle={() => setShowSecret((s) => !s)}
                  />
                </Field>
              </div>
            </div>
          </>
        ) : null}

        <div className="form-row-2">
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

        <label className="check">
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

      {mode === "edit" && initial ? (
        <form
          action={deactivateStoreAction}
          style={{ paddingTop: 14, borderTop: "1px solid var(--border)" }}
        >
          <input type="hidden" name="id" value={initial.id} />
          <button
            type="submit"
            className="ghost-btn"
            style={{ color: "var(--negative)" }}
          >
            <Trash2 size={13} strokeWidth={2} />
            Deactivate store
          </button>
        </form>
      ) : null}
    </div>
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

function EyeToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="eye-btn"
      onClick={onToggle}
      aria-label={on ? "Hide value" : "Show value"}
      tabIndex={-1}
    >
      {on ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
}

function AuthStateBadge({
  credSource,
  hasStatic,
  hasOAuth,
}: {
  credSource: "db" | "env" | "none";
  hasStatic: boolean;
  hasOAuth: boolean;
}) {
  if (credSource === "db") {
    const label = hasStatic
      ? "Token stored in DB"
      : hasOAuth
        ? "OAuth credentials in DB"
        : "Stored";
    return (
      <span className="auth-state ok">
        <span className="dot" /> {label}
      </span>
    );
  }
  // "env" is legacy — kept in the union for backward compat with any
  // unmigrated tooling, but page.tsx now only emits "db" or "none".
  return (
    <span className="auth-state warn">
      <span className="dot" /> Not configured
    </span>
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

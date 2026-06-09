// Single source of truth for what the edit system is allowed to write.
//
// This file is the ONLY place that authorizes data mutations. Every edit
// tool + the confirm endpoint check against this whitelist before doing
// anything. If a table/column isn't here, it's not editable — full stop.
//
// What's deliberately excluded:
//   - DDL operations (CREATE, DROP, ALTER, TRUNCATE) — banned everywhere.
//   - Multi-row deletes — we never let the model delete rows.
//   - tenant_id, user_id, primary keys — set server-side, never from the
//     model's input.
//   - Encrypted fields (shopify_token_encrypted, etc.) — would be
//     meaningless to overwrite anyway.
//   - Anything in chat_*, integrations, zoho_credentials, auth.* tables.
//
// Money sanity bounds:
//   - MIN_AMOUNT: 0 (no negative amounts — refunds are tracked separately)
//   - MAX_AMOUNT: $10M per single entry. Single-day spend > $10M on one
//     store is implausible; if it ever happens, the edit must come from
//     a human in the dashboard, not the chat.

export const EDITABLE_TABLES = [
  "ad_spend_entries",
  "cogs_entries",
  "manual_revenue_entries",
] as const;

export type EditableTable = (typeof EDITABLE_TABLES)[number];

/** What the model is allowed to ask for per table. The confirm endpoint
 *  uses a hand-written writer per table — these column names are what
 *  appear in `after_value` JSON and what the writer reads from. */
export const EDITABLE_COLUMNS_PER_TABLE: Record<EditableTable, string[]> = {
  ad_spend_entries: ["amount", "reason"],
  cogs_entries: ["cogs", "reason"],
  manual_revenue_entries: ["amount", "reason"],
};

/** Logical identity columns the model provides to pick the row. These
 *  appear in `target_pk` JSON. The server reads them verbatim into a
 *  parameterized DELETE/INSERT — no string concat ever. */
export const TARGET_PK_PER_TABLE: Record<EditableTable, string[]> = {
  ad_spend_entries: ["store_id", "date"],
  cogs_entries: ["store_id", "date"],
  manual_revenue_entries: ["store_id", "date", "revenue_type"],
};

/** Store IDs the model commonly references — used in classifier
 *  examples and prompts. The actual ownership check (does this tenant
 *  have this store?) happens at the DB layer in each edit tool, so
 *  this list doesn't need to be exhaustive. */
export const COMMON_STORE_IDS = [
  "NOVA",
  "NURA",
  "KOVA",
  "ELARA",
  "SOLEN",
  "VOLEN",
  "NEEDOH",
] as const;
export type StoreId = string;

/** Money bounds enforced by every edit tool AND the confirm writer. */
export const MONEY_BOUNDS = {
  min: 0,
  max: 10_000_000,
} as const;

/** Date bounds enforced everywhere. Edits can target any day in the last
 *  5 years up through 7 days into the future. Beyond that we reject — it's
 *  either a typo or someone fishing for a row that doesn't exist. */
export const DATE_BOUNDS = {
  past_years: 5,
  future_days: 7,
} as const;

/** Max number of pending confirmations one user can have open at once.
 *  Stops a runaway model from staging dozens of edits in one turn. */
export const MAX_PENDING_PER_USER = 5;

// ─── Helpers ────────────────────────────────────────────────────────────

export function isEditableTable(t: string): t is EditableTable {
  return (EDITABLE_TABLES as readonly string[]).includes(t);
}

/** Loose shape check for store ids — uppercase letters, digits,
 *  underscores. The strict "does this store actually exist for the
 *  caller's tenant?" check happens in the DB layer. */
export function isWellFormedStoreId(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length < 2 || s.length > 32) return false;
  return /^[A-Z0-9_]+$/.test(s);
}

/** Validate an amount value before it touches the DB. Returns the
 *  rounded-to-2dp value on success, throws with a user-safe message
 *  otherwise. */
export function validateAmount(raw: unknown, label = "amount"): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a number`);
  }
  if (n < MONEY_BOUNDS.min) {
    throw new Error(`${label} can't be negative`);
  }
  if (n > MONEY_BOUNDS.max) {
    throw new Error(
      `${label} of $${n.toLocaleString()} is above the safety cap. Edit through the dashboard for large corrections.`,
    );
  }
  return Math.round(n * 100) / 100;
}

/** Validate a date string is YYYY-MM-DD and inside the allowed window. */
export function validateDate(raw: unknown, label = "date"): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be in YYYY-MM-DD format`);
  }
  const t = new Date(`${raw}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) throw new Error(`${label} isn't a real date`);
  const now = Date.now();
  const maxFuture = now + DATE_BOUNDS.future_days * 86_400_000;
  const minPast = now - DATE_BOUNDS.past_years * 365 * 86_400_000;
  if (t > maxFuture) {
    throw new Error(`${label} is too far in the future`);
  }
  if (t < minPast) {
    throw new Error(`${label} is too far in the past`);
  }
  return raw;
}

/** Validate a store id passes shape checks only. Tenant ownership is
 *  enforced at the DB layer in each edit tool — that lookup is per-
 *  tenant so it's the only source of truth for "does this store
 *  belong to this user". */
export function validateStoreId(raw: unknown, label = "store_id"): StoreId {
  if (typeof raw !== "string") throw new Error(`${label} must be a string`);
  const u = raw.toUpperCase().trim();
  if (!isWellFormedStoreId(u)) {
    throw new Error(
      `${label} "${raw}" isn't a valid store code (uppercase letters/digits/underscore, 2-32 chars).`,
    );
  }
  return u;
}

/** Validate revenue_type — short alphanumeric label. */
export function validateRevenueType(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("revenue_type must be a string");
  }
  const t = raw.trim().toLowerCase();
  if (t.length < 2 || t.length > 64) {
    throw new Error("revenue_type must be 2-64 characters");
  }
  if (!/^[a-z0-9_\- ]+$/.test(t)) {
    throw new Error(
      "revenue_type can only contain letters, numbers, spaces, underscores, hyphens",
    );
  }
  return t;
}

/** Validate optional reason text — strip control chars, cap length. */
export function validateReason(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  // Strip ASCII control chars (except newline/tab) and clamp length.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 280);
}

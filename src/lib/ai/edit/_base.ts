// Shared types + security helpers for the EDIT chat flow.
//
// This file is intentionally SEPARATE from src/lib/ai/categories/_base.ts.
// The read system and the edit system don't share types or detectors —
// they have different risk profiles and different prompts. Don't import
// across the boundary.
//
// Edit security model:
//   1. /api/chat/edit only fires when the request body carries
//      edit_mode: true AND the user has owner|admin|manager role.
//   2. Every write tool the AI calls lands in pending_confirmations
//      with before_value + after_value — no row gets modified yet.
//   3. The UI renders a confirm card. Only the user clicking Confirm
//      (with the pending id) actually mutates data.
//   4. Every applied edit writes to chat_audit_log with both values
//      so it's reversible and auditable.

import type { ZodType } from "zod";

// ─── Category module shape (edit-specific) ────────────────────────────────
export type EditCategoryId =
  | "ad_spend_edit"
  | "cogs_edit"
  | "revenue_edit"
  | "edit_core";

/** A write-tool template inside an edit category. Each tool:
 *   - Validates params via Zod.
 *   - Looks up the CURRENT row.
 *   - Creates a pending_confirmations entry.
 *   - Returns a structured "needs confirmation" payload to the model.
 *  The actual write happens in a separate /api/chat/confirm step. */
export type EditTool = {
  /** Stable key the model selects. */
  id: string;
  /** One-line description the classifier + model see. */
  description: string;
  /** Zod schema for the params the model will provide. */
  params_schema: ZodType;
  /** Builds a pending_confirmations row. Returns either:
   *   - { kind: "needs_confirmation", pending_id, summary, before, after }
   *   - { kind: "error", message }
   *   - { kind: "noop", message } (when current value already matches) */
  build: (params: unknown, ctx: EditContext) => Promise<EditBuildResult>;
};

export type EditContext = {
  /** Authenticated tenant — never derived from message. */
  tenantId: string;
  /** Authenticated user id — recorded on the audit row. */
  userId: string;
  /** Current chat session — confirmations link back to it. */
  sessionId: string;
  /** Message id the tool call was emitted from (optional). */
  messageId?: string | null;
  /** Today's date in UTC. */
  today: string;
};

export type EditBuildResult =
  | {
      kind: "needs_confirmation";
      pending_id: string;
      tool_name: string;
      target_table: string;
      target_pk: Record<string, unknown>;
      before_value: Record<string, unknown> | null;
      after_value: Record<string, unknown>;
      human_summary: string;
    }
  | { kind: "noop"; message: string }
  | { kind: "error"; message: string };

export type EditCategoryModule = {
  id: EditCategoryId;
  name: string;
  /** What this category is responsible for — classifier reads this. */
  description: string;
  /** Sample user phrasings the classifier should match. */
  examples: string[];
  /** Category-specific system prompt fragment appended to the base
   *  edit prompt. */
  prompt: string;
  /** Write tools the model may request. */
  tools: EditTool[];
};

// ─── Edit-mode intent detector ────────────────────────────────────────────
/**
 * EDIT-mode intent detector. Aggressively rejects anything that isn't a
 * plain-English instruction to update one of the three editable tables
 * (ad_spend_entries, cogs_entries, manual_revenue_entries).
 *
 * Always-blocked:
 *   - DDL verbs (DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE)
 *   - Destructive intent on tables, schemas, or the database itself
 *   - SQL injection patterns
 *   - Prompt-injection / role-escalation
 *   - Code-shaped inputs (raw SQL, JSON, function calls, etc.)
 *   - References to system tables (auth.*, pg_*, information_schema)
 *   - Bulk operations ("delete everything", "drop all", "reset")
 *   - Operations on out-of-scope tables (tenants, stores, chat_*, etc.)
 *
 * Allowed:
 *   - Natural-language single-row updates on ad spend / COGS / manual
 *     revenue ("change X to Y", "set NOVA cogs to 100", "fix May 1 ads")
 *
 * Returns a rejection reason string if blocked, or null if safe.
 */
export function detectEditForbiddenIntent(message: string): string | null {
  const raw = message.trim();
  if (raw.length === 0) return null;
  const m = raw.toLowerCase();

  // ── DDL verbs anywhere in the message ─────────────────────────────────
  // We're more aggressive than the read detector — even mentioning "drop
  // table" in passing is a no-go. Same for create/alter/truncate.
  const ddl = [
    /\bdrop\s+(table|database|schema|index|view|function|role|user|policy|trigger|sequence|constraint)\b/i,
    /\btruncate\s+(table\s+)?\w+/i,
    /\bdelete\s+from\b/i,
    /\binsert\s+into\b/i,
    /\bupdate\s+\w+\s+set\b/i,
    /\balter\s+(table|database|schema|role|user|policy|sequence)\b/i,
    /\bgrant\s+\w+\s+on\b/i,
    /\brevoke\s+\w+\s+on\b/i,
    /\bcreate\s+(table|database|user|role|policy|function|index|view|sequence|trigger)\b/i,
    /\b(comment|rename)\s+(on|table|column)\b/i,
    /\bvacuum\b/i,
    /\breindex\b/i,
    /\bcluster\b/i,
    /\bcopy\s+\w+\s+(from|to)\b/i,
  ];
  for (const re of ddl) if (re.test(m)) return "ddl_or_mutation";

  // ── Destructive natural-language intent ───────────────────────────────
  // Catches "drop all chargebacks", "delete the stores table",
  // "wipe everything", "reset the database", "clear all data".
  const destructive = [
    /\b(drop|delete|remove|wipe|clear|erase|destroy|purge|nuke|reset)\s+(the\s+|all\s+|every\s+)?(table|tables|database|db|schema|row|rows|records?|data|everything|all\b|entries|history)/i,
    /\b(delete|remove|wipe)\s+(everything|all\s+\w+|the\s+\w+\s+table)/i,
    /\bdo\s+not\s+save\b/i,
    /\bbypass\s+confirmation\b/i,
  ];
  for (const re of destructive) if (re.test(m)) return "destructive_intent";

  // ── References to system / internal tables ───────────────────────────
  const systemRefs = [
    /\binformation_schema\b/i,
    /\bpg_catalog\b/i,
    /\bpg_class\b/i,
    /\bpg_user\b/i,
    /\bpg_shadow\b/i,
    /\bpg_database\b/i,
    /\bpg_namespace\b/i,
    /\bauth\.users\b/i,
    /\bauth\.\w+/i,
    // Our own non-editable tables — refusing here is friendlier than
    // letting the model try and fail.
    /\b(tenants|tenant_memberships|integrations|zoho_credentials|chat_(sessions|messages|audit_log)|pending_confirmations|chargeblast_alerts|phx_(subscribers|rebills|cohorts|summary_snapshots)|daily_(orders|pnl|ad_spend)|products|stores)\s+(table|row|column|schema)/i,
  ];
  for (const re of systemRefs) if (re.test(m)) return "out_of_scope_table";

  // ── SQL injection patterns ────────────────────────────────────────────
  const sql = [
    /;\s*(drop|delete|truncate|update|insert|alter|create|grant|revoke)\b/i,
    /\bunion\s+(all\s+)?select\b/i,
    /--\s*\w/,
    /\/\*[\s\S]*?\*\//,
    /\bxp_cmdshell\b/i,
    /\bload_file\s*\(/i,
    /\binto\s+outfile\b/i,
    /\bsleep\s*\(\s*\d+/i,
    /\bpg_sleep\s*\(/i,
    /['"]\s*(or|and)\s+\d+\s*=\s*\d+/i,
    /['"]\s*(or|and)\s+['"]\w+['"]\s*=\s*['"]\w+/i,
    /\bWAITFOR\s+DELAY\b/i,
    /\bbenchmark\s*\(/i,
  ];
  for (const re of sql) if (re.test(message)) return "sql_injection";

  // ── Prompt injection / role escalation ───────────────────────────────
  const inject = [
    /\bignore\s+(previous|all|the)\s+(instructions?|prompt|rules)/i,
    /\bdisregard\s+(previous|the|all)\s+(instructions?|prompt|rules)/i,
    /\byou\s+are\s+now\s+(a|an|the)?\s*(?:admin|root|developer|system|owner)/i,
    /\bact\s+as\s+(an?\s+)?(admin|root|developer|system|jailbroken|owner)/i,
    /\bsystem\s*[:>=]\s*/i,
    /\b<\s*\/?system\s*>\b/i,
    /\bjailbreak\b/i,
    /\bDAN\s+mode\b/i,
    /\bsudo\b/i,
    /\bbypass\s+(security|the\s+confirmation|the\s+rule)/i,
    /\bskip\s+(confirmation|validation|the\s+check)/i,
    /\boverride\s+(security|safety|the\s+rule|tenant)/i,
  ];
  for (const re of inject) if (re.test(m)) return "prompt_injection";

  // ── Code-shaped input ────────────────────────────────────────────────
  if (looksLikeCode(raw)) return "non_natural_language";

  // ── Excessive length / token-flood attempts ──────────────────────────
  if (raw.length > 2000) return "too_long";

  return null;
}

function looksLikeCode(raw: string): boolean {
  const m = raw.toLowerCase().trim();
  if (m.length < 3) return false;
  const sqlShape = [
    /^\s*select\s+[\w*\s,()]+\s+from\s+\w+/i,
    /^\s*with\s+\w+\s+as\s*\(/i,
    /\bfrom\s+\w+\s+(where|join|inner\s+join|left\s+join|order\s+by|group\s+by|limit)\b/i,
    /\bjoin\s+\w+\s+on\b/i,
  ];
  for (const re of sqlShape) if (re.test(raw)) return true;
  if (
    (raw.startsWith("{") || raw.startsWith("[")) &&
    /["']\s*\w+\s*["']\s*:/.test(raw)
  )
    return true;
  if (
    /\b(curl|fetch|wget|http[s]?:\/\/)/i.test(raw) ||
    /^\s*(get|post|put|patch|delete)\s+\/\w/i.test(raw)
  )
    return true;
  if (/<\/?[a-z][\s\S]*?>/i.test(raw) && /<\/[a-z]/i.test(raw)) return true;
  if (/^\s*\w+\s*\([^)]*\)\s*;?\s*$/.test(raw)) return true;
  const symbolMatches = raw.match(/[{}[\]<>;=`]/g);
  const symbolCount = symbolMatches ? symbolMatches.length : 0;
  if (raw.length > 20 && symbolCount / raw.length > 0.15) return true;
  return false;
}

/** Human-friendly rejection — never echoes the user's text or hints at
 *  internals. The reason code is logged server-side for audit. */
export function friendlyEditRejection(reason: string): string {
  switch (reason) {
    case "ddl_or_mutation":
    case "sql_injection":
      return "I can't run raw database commands. Tell me in plain English what you want to change — for example, 'change NOVA ad spend on May 1 to $2,000'.";
    case "destructive_intent":
      return "I can only update one entry at a time, and I can't delete or wipe data. Tell me which single value you'd like corrected.";
    case "out_of_scope_table":
      return "That table isn't editable from chat. I can update ad spend, COGS, or manual revenue entries — anything else stays read-only.";
    case "prompt_injection":
      return "I'll stay focused on edits to your business data. Which value would you like to update?";
    case "non_natural_language":
      return "Please describe the edit in plain English — like 'change NOVA ad spend on May 1 to $2,000'.";
    case "too_long":
      return "That message is too long for me to process as an edit. Try a single concise instruction.";
    default:
      return "I can't make that change. Try rephrasing — for example, 'change NOVA ad spend on May 1 to $2,000'.";
  }
}

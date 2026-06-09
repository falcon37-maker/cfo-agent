// Shared types + security helpers for the category-routed chat system.
//
// Security model (READ-ONLY, no exceptions):
//   1. Every query is a typed, parameterized call to a vetted DB function
//      (loadPnlLedger, loadStores, etc.). There is NO raw SQL acceptance
//      from the model. The model picks WHICH template to run and provides
//      WHICH params; it never authors SQL.
//   2. All params go through Zod schemas before reaching the DB layer.
//   3. Queries run under the service-role client BUT scoped explicitly to
//      the authenticated tenantId — never the model's choice.
//   4. Result size is capped per template (table_threshold). Large results
//      bypass Claude entirely and stream to the UI as a structured table.
//   5. Forbidden intents (edit/delete/sql/system) trip a rule-violation
//      response before the query ever runs. The attempt is logged.

import type { ZodType } from "zod";

// ─── Category module shape ────────────────────────────────────────────────
export type CategoryId =
  | "core"
  | "revenue"
  | "pnl"
  | "subscriptions"
  | "chargebacks"
  | "stores"
  | "ad_spend"
  | "cogs"
  | "trends"
  | "forecasting"
  | "customer_data"
  | "refunds"
  | "security"
  | "guidance"
  | "operations";

/** A single pre-built query template inside a category.
 *
 *  Note on types: the runner receives `unknown` params because the array
 *  this template lives in mixes different param shapes. Each query is
 *  expected to call `params_schema.parse(raw)` internally OR cast to its
 *  own input type — the runner in categories/index.ts validates against
 *  the schema first, then hands the result to `run`. */
export type QueryTemplate = {
  /** Stable key the model selects by name. */
  id: string;
  /** One-line description shown to the model in the classifier prompt. */
  description: string;
  /** Zod schema that validates params before execution. Rejects anything
   *  the schema doesn't recognize. */
  params_schema: ZodType;
  /** Resolver: tenantId is passed explicitly — never trust the model.
   *  `params` is already Zod-validated by the runner; cast to the
   *  template's own input type inside the function. */
  run: (params: unknown, ctx: QueryContext) => Promise<unknown>;
  /** If result is an array longer than this, stream as table instead of
   *  sending to Claude. null = always send to Claude (small data). */
  table_threshold: number | null;
  /** When in table mode, which keys become columns (in order). */
  table_columns?: string[];
  /** Optional column display labels (column key → header label). */
  table_column_labels?: Record<string, string>;
  /** Optional column formatters: "money" | "pct" | "date" | "int" */
  table_column_format?: Record<string, "money" | "pct" | "date" | "int">;
};

export type QueryContext = {
  /** Authenticated tenant. Never derived from the user message. */
  tenantId: string;
  /** Today's date (UTC) so date math is consistent across calls. */
  today: string;
};

export type CategoryModule = {
  id: CategoryId;
  name: string;
  /** Plain-English description used by the classifier to route. */
  description: string;
  /** Topics this category handles — feeds into classifier examples. */
  examples: string[];
  /** Category-specific system prompt fragment appended to the base prompt. */
  prompt: string;
  /** Pre-built query templates the model can request by id. */
  queries: QueryTemplate[];
  /** Suggestions to return when the response path can't ask the AI to
   *  generate them (table mode skips the main LLM entirely). For text
   *  responses the AI is required to produce its own contextual
   *  suggestions, so this list is essentially unused there. Categories
   *  may pass an empty array to opt out completely. */
  fallback_suggestions: string[];
  /** Role gate — if set, only these roles can ask questions in this
   *  category. Phase 1 is read-only so this is mostly aspirational, but
   *  audit/security categories already need it. */
  required_roles?: Array<"owner" | "admin" | "manager" | "viewer">;
};

// ─── Result types ─────────────────────────────────────────────────────────
/** Returned from runQuery() — either small enough for Claude to summarize,
 *  or large enough that the UI should render it as a table. */
export type QueryResult =
  | {
      mode: "text";
      /** Small JSON payload that gets serialized into the assistant context. */
      data: unknown;
      query_id: string;
    }
  | {
      mode: "table";
      query_id: string;
      rows: Record<string, unknown>[];
      columns: TableColumn[];
      /** Short text describing the table, fed to Claude as context but the
       *  user sees the table directly. */
      summary: string;
    };

export type TableColumn = {
  key: string;
  label: string;
  format?: "money" | "pct" | "date" | "int" | "text";
};

// ─── Security: forbidden intent detection ─────────────────────────────────
/**
 * Phase 1 is strictly read-only AND only accepts natural-language questions
 * about the business. We block:
 *   - DDL / mutation verbs (DROP, DELETE FROM, UPDATE SET, etc.)
 *   - Direct SQL injection patterns (;DROP, UNION SELECT, comments)
 *   - Prompt-injection / role-escalation attempts
 *   - Edit intent in natural language ("change X to Y")
 *   - Code-shaped inputs (raw SQL fragments, JSON payloads, function calls)
 *     — if someone is pasting SELECT/curl/JSON into the chat box, they're
 *     not asking a finance question.
 *
 * Returns a rejection reason string if blocked, or null if safe.
 */
export function detectForbiddenIntent(message: string): string | null {
  const raw = message.trim();
  if (raw.length === 0) return null;
  const m = raw.toLowerCase();

  // ── DDL / mutation verbs ────────────────────────────────────────────────
  const ddl = [
    /\bdrop\s+(table|database|schema|index|view|function)\b/,
    /\btruncate\s+(table)?\b/,
    /\bdelete\s+from\b/,
    /\binsert\s+into\b/,
    /\bupdate\s+\w+\s+set\b/,
    /\balter\s+(table|database|schema|role|user|policy)\b/,
    /\bgrant\s+\w+\s+on\b/,
    /\brevoke\s+\w+\s+on\b/,
    /\bcreate\s+(table|database|user|role|policy|function|index|view)\b/,
  ];
  for (const re of ddl) {
    if (re.test(m)) return "ddl_or_mutation";
  }

  // ── Edit intent in plain English (Phase 1 has no write tools) ───────────
  // The financial-term list catches both "change ad spend" and
  // "set NOVA cogs to 100" where a store name sits between the verb and
  // the metric.
  const edit = [
    /\b(change|set|modify|update|edit|overwrite|fix)\s+(?:\w+\s+){0,3}(ad\s*spend|cogs|revenue|net\s*profit|fees|refund|store|tenant)/,
    /\bdelete\s+(the\s+)?(entry|row|record|conversation|chat|store|user|tenant)/,
    /\bremove\s+(the\s+)?(entry|row|record|store|user|tenant|member)/,
  ];
  for (const re of edit) {
    if (re.test(m)) return "edit_intent";
  }

  // ── SQL injection patterns ──────────────────────────────────────────────
  const sql = [
    /;\s*(drop|delete|truncate|update|insert|alter|create|grant)\b/i,
    /\bunion\s+(all\s+)?select\b/i,
    /--\s*\w/,
    /\/\*[\s\S]*?\*\//,
    /\bxp_cmdshell\b/i,
    /\bload_file\s*\(/i,
    /\binto\s+outfile\b/i,
    /\bsleep\s*\(\s*\d+/i,
    /\bpg_sleep\s*\(/i,
    /\binformation_schema\b/i,
    /\bpg_catalog\b/i,
    // Classic "or 1=1" tautology used to bypass auth/filter checks.
    /['"]\s*(or|and)\s+\d+\s*=\s*\d+/i,
    /['"]\s*(or|and)\s+['"]\w+['"]\s*=\s*['"]\w+/i,
  ];
  for (const re of sql) {
    if (re.test(message)) return "sql_injection";
  }

  // ── Prompt injection / role escalation ──────────────────────────────────
  const inject = [
    /\bignore\s+(previous|all|the)\s+(instructions?|prompt|rules)/,
    /\bdisregard\s+(previous|the|all)\s+(instructions?|prompt|rules)/,
    /\byou\s+are\s+now\s+(a|an|the)?\s*(?:admin|root|developer|system)/,
    /\bact\s+as\s+(an?\s+)?(admin|root|developer|system|jailbroken)/,
    /\bsystem\s*[:>=]\s*/,
    /\b<\s*\/?system\s*>\b/,
    /\bjailbreak\b/,
    /\bDAN\s+mode\b/i,
  ];
  for (const re of inject) {
    if (re.test(m)) return "prompt_injection";
  }

  // ── Code-shaped input (anything that doesn't look like a sentence) ──────
  // The chat is for plain-language questions only. If the user is pasting
  // SQL, JSON, curl, function calls, or HTML, route to the block category.
  if (looksLikeCode(raw)) return "non_natural_language";

  return null;
}

/**
 * Heuristic: does this message look like code/markup/structured data
 * rather than a natural-language question?
 *
 * Triggers on:
 *   - Standalone SELECT/FROM/WHERE clauses (raw SQL fragments)
 *   - JSON-shaped payloads ({"key": "value"})
 *   - URL-shaped inputs (curl / fetch / http requests)
 *   - HTML/XML tags
 *   - Function-call shapes like fn(...)
 *   - High density of code symbols (>20% of chars are {}[]<>;=)
 */
function looksLikeCode(raw: string): boolean {
  const m = raw.toLowerCase().trim();
  if (m.length < 3) return false;

  // Raw SQL fragments (even without DDL — bare SELECT is still a query).
  const sqlShape = [
    /^\s*select\s+[\w*\s,()]+\s+from\s+\w+/i,
    /^\s*with\s+\w+\s+as\s*\(/i,
    /\bfrom\s+\w+\s+(where|join|inner\s+join|left\s+join|order\s+by|group\s+by|limit)\b/i,
    /\bjoin\s+\w+\s+on\b/i,
  ];
  for (const re of sqlShape) {
    if (re.test(raw)) return true;
  }

  // JSON payload shape: starts with { or [, contains "key":
  if (
    (raw.startsWith("{") || raw.startsWith("[")) &&
    /["']\s*\w+\s*["']\s*:/.test(raw)
  ) {
    return true;
  }

  // URL / HTTP request shape.
  if (
    /\b(curl|fetch|wget|http[s]?:\/\/)/i.test(raw) ||
    /^\s*(get|post|put|patch|delete)\s+\/\w/i.test(raw)
  ) {
    return true;
  }

  // HTML/XML tags.
  if (/<\/?[a-z][\s\S]*?>/i.test(raw) && /<\/[a-z]/i.test(raw)) {
    return true;
  }

  // Function-call shape: name(...) on its own line, no English around it.
  if (/^\s*\w+\s*\([^)]*\)\s*;?\s*$/.test(raw)) {
    return true;
  }

  // Density check: too many code symbols suggests structured input.
  const symbolMatches = raw.match(/[{}[\]<>;=`]/g);
  const symbolCount = symbolMatches ? symbolMatches.length : 0;
  const ratio = symbolCount / raw.length;
  if (raw.length > 20 && ratio > 0.15) return true;

  return false;
}

/** Human-readable message returned to the user when an intent is blocked.
 *  Intentionally generic — we don't echo the offending text or hint at
 *  internals. */
export function friendlyRejection(reason: string): string {
  switch (reason) {
    case "ddl_or_mutation":
    case "sql_injection":
      return "I can only read data right now. Direct database commands aren't something I'll run.";
    case "edit_intent":
      return "I can't edit numbers yet — that's coming in the next phase. I can show you the current value if that helps.";
    case "prompt_injection":
      return "I'll stick to helping you understand your business data. What would you like to look at?";
    case "non_natural_language":
      return "Please ask me a question in plain English. I don't accept queries, code, or structured input — just type what you want to know about your business.";
    default:
      return "That isn't something I can help with right now. Try asking about your stores, revenue, subscribers, or chargebacks.";
  }
}

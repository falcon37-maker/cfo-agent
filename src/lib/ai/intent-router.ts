// Auto intent router. Decides whether a chat message wants to READ data
// or EDIT data, so the /api/chat endpoint can transparently forward the
// request to the edit pipeline without the user toggling a UI switch.
//
// Two-stage decision:
//   1. Fast regex heuristic — clear edit verbs ("set", "change", "update",
//      "fix", "correct", "add", "log", "record") + a target field
//      ("ad spend", "cogs", "revenue", "manual revenue", a dollar amount,
//      a date) trip the edit branch immediately.
//   2. If the heuristic is ambiguous, fall back to Haiku for a binary
//      classification. We keep this call cheap (16-token cap, one model
//      call) so the latency cost is small for non-trivial messages.
//
// Conservative bias: ambiguous → "read". The read path is harmless; the
// edit path puts a confirm card in front of the user. We'd rather under-
// route to edit than over-route, since a misrouted read still returns a
// useful answer ("I can't edit Shopify revenue") via the edit_core
// category if it does get there.
//
// This module has NO side effects (no DB, no persistence). Cheap to call
// before any state changes.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "@/lib/ai/client";

const ROUTER_MODEL = "claude-haiku-4-5";
const ROUTER_MAX_TOKENS = 16;

export type Intent = "read" | "edit";

const EDIT_VERBS = [
  "set", "change", "update", "fix", "correct", "edit",
  "modify", "adjust", "amend", "revise", "replace",
  "add", "log", "record", "enter", "insert", "create",
  "delete", "remove", "clear", "wipe",
  "increase", "decrease", "bump", "raise", "lower",
];

const EDIT_TARGETS = [
  "ad spend", "ad-spend", "adspend",
  "cogs", "cost of goods",
  "manual revenue", "coaching revenue", "consulting revenue",
];

const READ_VERBS = [
  "show", "list", "give", "tell", "what", "how", "when",
  "which", "who", "where", "why", "find", "compare",
  "summarize", "explain", "trend", "report",
];

/** Detect short follow-up shapes that should inherit the prior intent
 *  rather than being routed on their own. "yes please", "no", "ok",
 *  "confirm it", "go ahead", "do it" all mean "continue what we were
 *  doing", not "start a fresh read query". */
function isShortFollowUp(message: string): boolean {
  const m = message.toLowerCase().trim().replace(/[.!?]+$/, "");
  if (m.length > 40) return false;
  return (
    /^(yes|yep|yeah|yup|sure|ok|okay|sounds good|please do|do it|go ahead|confirm|confirm it|proceed|continue)( please)?$/i.test(m) ||
    /^(no|nope|nah|cancel|stop|wait|hold on)$/i.test(m) ||
    /^(yes|no)\s+/i.test(m)
  );
}

/** Walk back through recent history to find whether the conversation was
 *  most recently in edit context. Looks at the last few user turns. */
function priorIntentFromHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Intent | null {
  // Inspect the last 4 user turns for an explicit edit shape.
  const userTurns = history
    .filter((h) => h.role === "user")
    .slice(-4)
    .map((h) => h.content);
  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const h = heuristicIntent(userTurns[i]);
    if (h === "edit") return "edit";
    if (h === "read") return "read";
  }
  return null;
}

/** Fast pre-check. Returns 'edit' / 'read' for clear cases, or null when
 *  the message is too ambiguous to decide from regex alone. */
export function heuristicIntent(message: string): Intent | null {
  const m = message.toLowerCase().trim();
  if (!m) return "read";

  // Pure-question shapes are almost always reads.
  if (/^(what|when|how|why|who|which|where|show|list|give|tell)\b/i.test(m) && !m.includes("?")) {
    // still could be edit ("show me my ad spend" then implies read) — keep as null only if also contains edit verb
  }

  const hasEditVerb = EDIT_VERBS.some((v) =>
    new RegExp(`\\b${v}\\b`).test(m),
  );
  const hasEditTarget = EDIT_TARGETS.some((t) => m.includes(t));
  const hasDollar = /\$\s*\d|\b\d+(\.\d+)?\s*(usd|dollars?|k|million|m)\b/i.test(m);
  const hasToValue = /\bto\s+\$?\s*\d/.test(m);
  // Bare number anywhere — "add 100 NOVA", "set NOVA 5000", etc. We
  // require an edit verb too so plain reads like "5 stores" don't trip.
  const hasNumber = /\b\d{1,9}(?:[.,]\d+)?\b/.test(m);

  // Strong edit signals: imperative edit verb + (target OR money value OR
  // any plain number adjacent to an edit verb).
  if (hasEditVerb && (hasEditTarget || hasDollar || hasToValue || hasNumber)) {
    return "edit";
  }

  // Pure question / read verbs without edit verbs → read.
  const startsRead = READ_VERBS.some((v) =>
    new RegExp(`^${v}\\b`).test(m),
  );
  if (startsRead && !hasEditVerb) return "read";
  if (m.endsWith("?") && !hasEditVerb) return "read";

  return null;
}

/** Two-stage detector. Heuristic first; Haiku tiebreaker only when needed.
 *  Pass recent history so short follow-ups ("yes please", "do it") inherit
 *  the prior intent instead of bouncing the user back to read mode. */
export async function detectIntent(
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<Intent> {
  // Short follow-ups should stick with whatever mode we were in.
  if (isShortFollowUp(message)) {
    const prior = priorIntentFromHistory(history);
    if (prior) return prior;
  }

  // A bare dollar amount on its own (e.g. "$2000", "2200") inherits prior
  // intent too — the user is supplying a missing field for an in-flight
  // edit clarification.
  if (/^\$?\s*\d[\d,.\s]*$/.test(message.trim())) {
    const prior = priorIntentFromHistory(history);
    if (prior === "edit") return "edit";
  }

  const heur = heuristicIntent(message);
  if (heur) return heur;

  try {
    const client = anthropicClient();
    const resp = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: ROUTER_MAX_TOKENS,
      system: `Classify the user message as either "read" or "edit".

"edit" means: the user wants to change, set, add, delete, or correct a stored value (ad spend, COGS, manual revenue).
"read" means: the user wants information, a number, a trend, an explanation, or anything that does not mutate the database.

Greetings, vague messages, or anything unclear → "read".

Respond with exactly one word: read or edit.`,
      messages: [{ role: "user", content: message }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toLowerCase();
    if (text.startsWith("edit")) return "edit";
    return "read";
  } catch (e) {
    console.warn("[intent-router] fallback to read:", (e as Error).message);
    return "read";
  }
}

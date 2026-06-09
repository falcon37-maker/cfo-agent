// Cheap routing layer that picks ONE category + zero-or-one query template
// for an incoming user message. Uses Claude Haiku 4.5 because:
//   - $1/$5 per 1M tokens (5x cheaper than Sonnet)
//   - <1s typical latency
//   - The job is short classification, not deep reasoning
//
// The classifier output is structured JSON so the route handler doesn't
// need a second LLM pass to figure out what to run.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "@/lib/ai/client";
import type { CategoryId, CategoryModule } from "@/lib/ai/categories/_base";

const CLASSIFIER_MODEL = "claude-haiku-4-5";
const CLASSIFIER_MAX_TOKENS = 256;

export type ClassifierDecision = {
  /** Best-matching category from the registry. */
  category: CategoryId;
  /** Selected query template id (must exist in the category), or null if
   *  the category should respond from system context alone. */
  query_id: string | null;
  /** Parameters for the chosen query. Validated again by Zod downstream. */
  params: Record<string, unknown>;
  /** Free-text reason — useful for debugging + audit, NOT shown to user. */
  reason: string;
  /** 0..1 confidence. Below threshold falls back to "core". */
  confidence: number;
};

const FALLBACK: ClassifierDecision = {
  category: "core",
  query_id: null,
  params: {},
  reason: "fallback_to_core",
  confidence: 0,
};

/** Build the classifier system prompt from the live category registry so
 *  adding/removing categories never requires touching this file. */
function buildClassifierPrompt(modules: CategoryModule[]): string {
  const catList = modules
    .map((m) => {
      const queries = m.queries
        .map((q) => `      - "${q.id}": ${q.description}`)
        .join("\n");
      return `  ${m.id} — ${m.description}
    examples: ${m.examples.slice(0, 3).join(" | ")}
    queries:
${queries || "      (none — answer from context)"}`;
    })
    .join("\n\n");

  return `You are a routing classifier for a finance-operations assistant. You don't answer the user — you decide WHICH category should handle their question and WHICH pre-built query (if any) to run.

# Categories

${catList}

# Routing rules

Greetings / small talk / acknowledgements ("hi", "hello", "thanks", "ok", "cool"):
  → category = "core", query_id = null. These are conversational, not data questions.

Identity / capability questions ("who are you?", "what can you do?", "help", "how does this work?"):
  → category = "guidance", query_id = null.

Vague open-ended questions ("how are things?", "give me a summary", "anything important?"):
  → category = "core", query_id = null. The main model answers from the live snapshot in the system prompt.

Specific data questions:
  → Pick the most specific category, then the most specific query template that matches.
  → If multiple categories fit, prefer the more specific one (e.g. "ad spend trend" → ad_spend, not revenue).
  → If the user references a follow-up from the previous turn ("what about NURA?", "compare it to last month"), use the prior conversation context to fill in what they mean.

Restricted topics:
  → security category is admin/owner-only. Route there if asked; the route handler will reject if the user lacks the role.

If nothing fits cleanly: category = "core", query_id = null, confidence < 0.6.

# Output format

Output ONE JSON object and nothing else. Schema:

{
  "category":   <one of the category ids above>,
  "query_id":   <a query id from that category, or null>,
  "params":     <object with the params that query expects, or {}>,
  "reason":     <one short sentence — for logs, not the user>,
  "confidence": <0.0 to 1.0>
}

Param conventions:
- Dates are ISO YYYY-MM-DD strings. "this week" = last 7 days. "this month" = current calendar month MTD. "last month" = the previous full calendar month.
- A SINGLE day ("on May 15", "May 15", "yesterday") → set from=to=that exact date. Don't widen it.
- A SPECIFIC range ("from May 1 to May 10", "between Apr 1 and Apr 30") → set from and to to those exact dates.
- A NAMED period ("April", "Q1", "last week", "yesterday") → resolve to the actual from/to dates based on today's date.
- "days" is an integer count for rolling windows ending today.
- "store_id" is uppercase: NOVA, NURA, KOVA, ELARA, SOLEN, VOLEN, NEEDOH.
- If the range is vague, default to days=7 and note it in "reason".
- Never invent parameters that aren't in the query's parameter list.
- IMPORTANT: when the user names a specific date or range, ALWAYS pass from/to — never fall back to days=7 just because the date sits outside the default window. The system can pull any date.

Return ONLY the JSON, no prose, no markdown fence.`;
}

/** Run the classifier on a user message. Always returns a decision (falls
 *  back to "core" on any failure — never throws into the route handler).
 *
 *  We deliberately don't shortcut greetings / small talk in code. The
 *  classifier sees every message and picks the right category itself
 *  (greetings go to core, "what can you do" goes to guidance). The
 *  category's prompt then handles the response tone. */
export async function classifyMessage(
  message: string,
  modules: CategoryModule[],
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<ClassifierDecision> {
  try {
    const client = anthropicClient();
    // Only the last 4 turns of context — enough to disambiguate follow-ups
    // ("what about NURA?"), cheap enough to keep classifier fast.
    const recent = history.slice(-4).map((h) => ({
      role: h.role,
      content: h.content.slice(0, 600),
    }));

    const resp = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: CLASSIFIER_MAX_TOKENS,
      system: [
        {
          type: "text",
          text: buildClassifierPrompt(modules),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        ...recent.map((m) => ({
          role: m.role as Anthropic.MessageParam["role"],
          content: m.content,
        })),
        { role: "user" as const, content: message },
      ],
    });

    const text = extractText(resp.content);
    const parsed = safeParseDecision(text);
    if (!parsed) return FALLBACK;
    // Sanity check the chosen category actually exists.
    if (!modules.some((m) => m.id === parsed.category)) return FALLBACK;
    // Sanity check the chosen query (if any) exists on that category.
    if (parsed.query_id) {
      const mod = modules.find((m) => m.id === parsed.category);
      if (!mod?.queries.some((q) => q.id === parsed.query_id)) {
        parsed.query_id = null;
        parsed.params = {};
      }
    }
    return parsed;
  } catch (e) {
    console.error("[classifier] failed:", (e as Error).message);
    return FALLBACK;
  }
}

function extractText(content: Anthropic.ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

function safeParseDecision(text: string): ClassifierDecision | null {
  // Strip any markdown code fence the model might wrap the JSON in.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<ClassifierDecision>;
    if (typeof obj.category !== "string") return null;
    return {
      category: obj.category as CategoryId,
      query_id: typeof obj.query_id === "string" ? obj.query_id : null,
      params: obj.params && typeof obj.params === "object" ? obj.params : {},
      reason: typeof obj.reason === "string" ? obj.reason : "",
      confidence:
        typeof obj.confidence === "number"
          ? Math.max(0, Math.min(1, obj.confidence))
          : 0,
    };
  } catch {
    return null;
  }
}

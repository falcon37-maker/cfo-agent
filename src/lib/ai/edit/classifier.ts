// Edit-mode classifier. Picks which edit category should handle the user
// message. Mirrors the read-side classifier shape but with its own prompt
// + its own category list — no shared code.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "@/lib/ai/client";
import type { EditCategoryId, EditCategoryModule } from "./_base";

const CLASSIFIER_MODEL = "claude-haiku-4-5";
const CLASSIFIER_MAX_TOKENS = 256;

export type EditClassifierDecision = {
  category: EditCategoryId;
  reason: string;
  confidence: number;
};

const FALLBACK: EditClassifierDecision = {
  category: "edit_core",
  reason: "fallback_to_edit_core",
  confidence: 0,
};

function buildPrompt(modules: EditCategoryModule[]): string {
  const list = modules
    .map(
      (m) =>
        `  ${m.id} — ${m.description}\n    examples: ${m.examples
          .slice(0, 3)
          .join(" | ")}`,
    )
    .join("\n\n");
  return `You route messages in EDIT MODE. The user has explicitly enabled editing and wants to change a value. Decide which edit category should handle their message.

# Edit categories

${list}

# Routing rules

- The user MUST explicitly name the field they want to edit (ad spend, COGS, coaching, consulting, manual revenue). The store name alone is NOT enough.
- "change/set/fix/update ad spend [for X]" → ad_spend_edit
- "change/set/fix/update cogs [for X]" → cogs_edit
- "change/set/fix coaching / consulting / manual revenue [for X]" → revenue_edit
- "add 20k NOVA", "set X to $5000", "log $200 for KOVA" — NO field named → edit_core (it will ask which field).
- Greetings, "what can I edit", vague edit requests, or anything else → edit_core
- If the user is trying to edit Shopify revenue or PHX subscription revenue, route to edit_core (those aren't editable from chat; edit_core explains why).

# Critical

If you cannot identify which of the three editable fields (ad spend, COGS, manual revenue) the user means, route to edit_core. Do NOT guess. A store name without a field name is ALWAYS ambiguous.

# Output

Return ONE JSON object, no prose, no markdown:

{
  "category":   <one of: ad_spend_edit, cogs_edit, revenue_edit, edit_core>,
  "reason":     <one short sentence — for logs, not the user>,
  "confidence": <0.0 to 1.0>
}`;
}

export async function classifyEditMessage(
  message: string,
  modules: EditCategoryModule[],
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<EditClassifierDecision> {
  try {
    const client = anthropicClient();
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
          text: buildPrompt(modules),
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
    const parsed = safeParse(text);
    if (!parsed) return FALLBACK;
    if (!modules.some((m) => m.id === parsed.category)) return FALLBACK;
    return parsed;
  } catch (e) {
    console.error("[edit classifier] failed:", (e as Error).message);
    return FALLBACK;
  }
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function safeParse(text: string): EditClassifierDecision | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<EditClassifierDecision>;
    if (typeof obj.category !== "string") return null;
    return {
      category: obj.category as EditCategoryId,
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

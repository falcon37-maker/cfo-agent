// "core" is the catch-all category. The classifier routes here when:
//   - The user's intent doesn't match a more specific category
//   - Confidence is low for any other route
//   - The question is conversational / greetings / clarifications
//
// Core has no DB queries of its own — it answers from the system prompt's
// live snapshot (last 7 days + active subscribers). For anything that
// needs deeper data, the model is instructed to ask a more specific
// question that another category can handle.

import { z } from "zod";
import type { CategoryModule } from "./_base";

export const coreCategory: CategoryModule = {
  id: "core",
  name: "Overview",

  description:
    "General overview, greetings, clarifications, and questions that don't fit a more specific category. The fallback route.",

  examples: [
    "how are things?",
    "give me a summary",
    "hello",
    "what can you do?",
    "anything I should worry about?",
  ],

  prompt: `# Mode: Overview / Conversational

You handle three kinds of messages here:

(1) Greetings and small talk: "hi", "hello", "thanks", "ok", "cool", "good morning".
    Reply with one short friendly sentence. Don't pull metrics. Don't open with business numbers. Examples:
      User: "hi"           → "Hey — what would you like to look at?"
      User: "thanks"       → "Anytime. What else?"
      User: "good morning" → "Morning. What can I pull up for you?"

(2) Open-ended overview asks: "how are things?", "give me a summary", "anything important?", "what's the state of the business?".
    THIS is when you use the last-7-days snapshot in the system context to give a one-paragraph read. Pick the 1-2 numbers that matter most for the answer; don't list every metric.

(3) Specific but unrouted questions: the classifier couldn't place it cleanly.
    Answer what you can from the context, then in one short sentence suggest the more specific question that would help.

Hard rules for ALL three:
- Read the user's actual message before responding. Greetings ≠ summary requests.
- Never open with "Pretty solid week" or any canned phrase.
- Never invent metrics. Only use what's in the system context or what the user already said this conversation.
- Keep it short. One sentence for small talk; one short paragraph max for overviews.`,

  queries: [
    // Core deliberately has no DB query templates — answers come from the
    // shared business-context snapshot already baked into the system prompt.
    // Keeping this empty array makes the registry shape uniform.
    {
      id: "noop",
      description:
        "No-op placeholder; never actually run. Core answers from system context.",
      params_schema: z.object({}),
      run: async () => ({}),
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "how is revenue this week?",
    "how many active subscribers?",
    "any chargebacks I should look at?",
  ],
};

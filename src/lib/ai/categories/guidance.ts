// "guidance" — help / how-to / capabilities.
//
// This is a no-DB category. The system prompt itself answers — explains
// what the assistant can do, what it can't, where to click for actions
// that require manual entry, etc.
//
// Possible questions this handles:
//   - "what can you do?"
//   - "how do I add a store?"
//   - "how do I log COGS?"
//   - "can you change ad spend?" (answer: not yet, here's where to go)
//   - "help"
//   - "what's MRR?" (definitions)

import { z } from "zod";
import type { CategoryModule } from "./_base";

export const guidanceCategory: CategoryModule = {
  id: "guidance",
  name: "Help & Guidance",

  description:
    "Help, how-to, capabilities. Use when the user asks 'what can you do?', 'how do I...', or wants a definition of a term.",

  examples: [
    "what can you do?",
    "how do I add a store?",
    "how do I log COGS?",
    "can you change ad spend?",
    "what does ROAS mean?",
    "help",
    "how does this work?",
  ],

  prompt: `# Mode: Help & Guidance

The user is asking how the system works or how to do something.

Reply rules:
- Be concrete. Point to the actual page or button when relevant.
- Short answer first, then the where-to-click line.
- Editing data is NOT supported through the chat yet (Phase A is read-only). Direct them to the relevant page:
    • Log COGS         → /cogs
    • Log Ad Spend     → /ads
    • Log Revenue      → /revenue
    • Add/edit a store → Settings → Stores
    • Manage team      → Settings → Team
    • Integrations     → Settings → Integrations
- Definitions: keep them one sentence. The owner doesn't need a textbook.
- If the user asks "what can you do?", list 3-4 things you CAN do (read-only analysis), not a wall of capabilities.`,

  queries: [
    {
      id: "noop",
      description:
        "No-op placeholder; guidance answers from the prompt alone. The classifier should pick category=guidance with query_id=null.",
      params_schema: z.object({}),
      run: async () => ({}),
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "what can you do?",
    "how do I log COGS?",
    "where do I see chargebacks?",
  ],
};

// POST /api/chat/edit
//
// Edit-mode chat endpoint — completely separate from /api/chat.
//
// Flow:
//   1. Auth + role check (owner/admin/manager only).
//   2. Forbidden-intent check (edit's stricter detector).
//   3. Body validation.
//   4. Get/create chat session, persist user turn.
//   5. Classify into edit category.
//   6. Run Sonnet with the category's prompt + the category's tools.
//   7. When the model calls a tool, the tool stages a pending_confirmations
//      row and returns a needs_confirmation payload — NO data mutation here.
//   8. Persist assistant turn (with the confirmation payload attached).
//   9. Return mode:"text" reply + optional confirmations array for the UI.
//
// The actual write happens later in /api/chat/confirm when the user
// clicks the Confirm button.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { requireTenant } from "@/lib/tenant";
import {
  anthropicClient,
  anthropicMaxTokens,
  anthropicModel,
} from "@/lib/ai/client";
import {
  detectEditForbiddenIntent,
  friendlyEditRejection,
  type EditBuildResult,
} from "@/lib/ai/edit/_base";
import {
  ALL_EDIT_CATEGORIES,
  getEditCategory,
} from "@/lib/ai/edit/categories";
import { classifyEditMessage } from "@/lib/ai/edit/classifier";
import {
  consumeRateToken,
  extractText,
  getOrCreateSession,
  loadHistory,
  persistMessage,
} from "@/lib/ai/chat-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_INPUT_CHARS = 4000;
const MAX_TOOL_LOOP = 4;
const RATE_MAX_REQUESTS = 20; // tighter than read mode

const BodySchema = z.object({
  session_id: z.uuid().optional(),
  message: z.string().min(1).max(MAX_INPUT_CHARS),
});

export async function POST(req: NextRequest) {
  try {
    return await handleEditChat(req);
  } catch (e) {
    console.error("[/api/chat/edit] uncaught:", e);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Something went wrong on our end. Please try again.",
      },
      { status: 500 },
    );
  }
}

export async function handleEditChat(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────
  let tenant;
  try {
    tenant = await requireTenant();
  } catch {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Your session expired. Please refresh and sign in again.",
      },
      { status: 401 },
    );
  }

  // ── Role gate: viewer can't edit ────────────────────────────────────
  if (tenant.role === "viewer") {
    return NextResponse.json(
      {
        error: "forbidden",
        message:
          "Your role doesn't allow edits. Ask an admin or manager to make changes.",
      },
      { status: 403 },
    );
  }

  // ── Rate limit ──────────────────────────────────────────────────────
  if (!consumeRateToken("edit", tenant.user_id, RATE_MAX_REQUESTS)) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "You're sending edit messages too quickly. Wait a minute and try again.",
      },
      { status: 429 },
    );
  }

  // ── Body validation ─────────────────────────────────────────────────
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    console.warn("[/api/chat/edit] invalid body:", (e as Error).message);
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "That message couldn't be sent. Please try again.",
      },
      { status: 400 },
    );
  }

  // ── Forbidden-intent check ──────────────────────────────────────────
  const block = detectEditForbiddenIntent(body.message);
  const sessionId = await getOrCreateSession({
    sessionId: body.session_id,
    tenantId: tenant.id,
    userId: tenant.user_id,
    firstMessage: body.message,
  });
  await persistMessage({
    sessionId,
    tenantId: tenant.id,
    role: "user",
    content: body.message,
    blocks: [{ type: "text", text: body.message }],
  });

  if (block) {
    const reply = friendlyEditRejection(block);
    await persistMessage({
      sessionId,
      tenantId: tenant.id,
      role: "assistant",
      content: reply,
      blocks: [{ type: "text", text: reply }],
      toolName: `edit_blocked:${block}`,
    });
    return NextResponse.json({
      session_id: sessionId,
      mode: "text",
      reply,
      confirmations: [],
      meta: { blocked: true, reason: block, edit_mode: true },
    });
  }

  // ── Load history ────────────────────────────────────────────────────
  const history = await loadHistory(sessionId, tenant.id);
  const classifierHistory = history
    .filter((h) => h.role === "user" || h.role === "assistant")
    .map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));

  // ── Classify ────────────────────────────────────────────────────────
  const decision = await classifyEditMessage(
    body.message,
    ALL_EDIT_CATEGORIES,
    classifierHistory,
  );
  const category =
    getEditCategory(decision.category) ?? getEditCategory("edit_core")!;

  // ── Run Sonnet with the category's tools ────────────────────────────
  const systemPrompt = buildEditSystemPrompt({
    tenantName: tenant.display_name || "your business",
    category,
  });

  // Build Anthropic tool defs from the category's tool list. If the
  // category has no tools (edit_core), the model just replies.
  const toolDefs: Anthropic.Tool[] = category.tools.map((t) => ({
    name: t.id,
    description: t.description,
    input_schema: zodToToolSchema(t.params_schema),
  }));

  // Build conversation messages from history + new user message.
  const messages: Anthropic.MessageParam[] = [];
  for (const h of history) {
    if (h.role !== "user" && h.role !== "assistant") continue;
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: body.message });

  const client = anthropicClient();
  const model = anthropicModel();
  const max_tokens = anthropicMaxTokens();

  let finalText = "";
  const confirmations: Array<{
    pending_id: string;
    tool_name: string;
    target_table: string;
    target_pk: Record<string, unknown>;
    before_value: Record<string, unknown> | null;
    after_value: Record<string, unknown>;
    human_summary: string;
  }> = [];
  let totalIn = 0;
  let totalOut = 0;
  const t0 = Date.now();

  for (let iter = 0; iter < MAX_TOOL_LOOP; iter += 1) {
    const resp = await client.messages.create({
      model,
      max_tokens,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      messages,
    });
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;

    // Mark turns that emitted a tool_use as "intermediate" so the
    // history hydration + UI can filter them out — the final reply
    // after the tool result is the one the user actually wants to see.
    const isIntermediate = resp.stop_reason === "tool_use";

    await persistMessage({
      sessionId,
      tenantId: tenant.id,
      role: "assistant",
      content: extractText(resp.content),
      blocks: resp.content as Anthropic.ContentBlockParam[],
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      latencyMs: Date.now() - t0,
      // Special tag we look for when rebuilding history.
      toolName: isIntermediate ? `intermediate:${category.id}` : category.id,
    });

    messages.push({
      role: "assistant",
      content: resp.content as Anthropic.ContentBlockParam[],
    });

    if (!isIntermediate) {
      finalText = extractText(resp.content);
      break;
    }

    // Execute each tool the model invoked. Tools stage pending edits.
    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      const tool = category.tools.find((t) => t.id === tu.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            error: `Unknown tool: ${tu.name}`,
          }),
          is_error: true,
        });
        continue;
      }
      let result: EditBuildResult;
      try {
        result = await tool.build(tu.input, {
          tenantId: tenant.id,
          userId: tenant.user_id,
          sessionId,
          messageId: null,
          today: new Date().toISOString().slice(0, 10),
        });
      } catch (e) {
        // Surface the real error to the model so it can relay something
        // useful to the user. Errors thrown by createPending() (per-user
        // pending limit) and any unexpected DB exceptions land here.
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[/api/chat/edit] tool ${tu.name} threw: ${msg}`,
        );
        result = { kind: "error", message: msg };
      }

      if (result.kind === "needs_confirmation") {
        confirmations.push({
          pending_id: result.pending_id,
          tool_name: result.tool_name,
          target_table: result.target_table,
          target_pk: result.target_pk,
          before_value: result.before_value,
          after_value: result.after_value,
          human_summary: result.human_summary,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            staged: true,
            pending_id: result.pending_id,
            response_format: {
              max_words: 8,
              must_not_include: [
                "store code",
                "store name (NOVA, NURA, KOVA, etc.)",
                "dollar amounts ($)",
                "dates",
                "the words 'Click Confirm' or 'Click Cancel' or 'or Cancel to discard'",
                "before/after numbers",
                "the word 'staged' if you said it in your prior turn",
              ],
              good_examples: [
                "Ready to review below.",
                "Have a look.",
                "Take a look below.",
                "Check the card below.",
              ],
              bad_examples: [
                "I've staged the change — confirm below to apply it: NOVA | April 27, 2026 $X → $Y. Click Confirm to apply or Cancel to discard.",
                "Staging that update now!",
              ],
              reason:
                "The confirmation card UI already shows every detail and provides Confirm/Cancel buttons. Repeating the card content is redundant and visually noisy. Reply with ONE short sentence pointing at the card.",
            },
          }),
          is_error: false,
        });
      } else if (result.kind === "noop") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ noop: true, message: result.message }),
          is_error: false,
        });
      } else {
        // Error path — relay the actual reason to the model. The model
        // should tell the user this verbatim, not invent a generic
        // "something went wrong" message.
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            error: result.message,
            instruction:
              "Tell the user EXACTLY this error in plain language. Do not invent reasons or list things to check — just relay the message above.",
          }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) {
    finalText =
      "I couldn't finish that — could you rephrase or be more specific about which entry to change?";
  }

  // Defense-in-depth: the model occasionally hallucinates "editing isn't
  // wired up" or "you'll need to enter that manually" even though the
  // prompt forbids it. Detect and rewrite so the user never sees a false
  // claim about our write capability.
  finalText = scrubFalseNoWriteClaims(finalText);

  // When we have a confirmation card to render, the AI sometimes still
  // re-narrates the change ("I've set May 1 NOVA ad spend from $1500 to
  // $2000…") even though the prompt tells it not to. Strip those lines
  // server-side so the card isn't visually duplicated by prose above it.
  if (confirmations.length > 0) {
    finalText = stripCardEcho(finalText, confirmations);
  }

  return NextResponse.json({
    session_id: sessionId,
    mode: "text",
    reply: finalText,
    confirmations,
    meta: {
      edit_mode: true,
      category: category.id,
      tool_calls: confirmations.length,
    },
    usage: {
      input_tokens: totalIn,
      output_tokens: totalOut,
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function buildEditSystemPrompt(args: {
  tenantName: string;
  category: { name: string; prompt: string };
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const [y, m, d] = today.split("-").map(Number);
  // Build a clear "current date" line so the model never guesses the year.
  // The model has been seen inventing past years for relative phrases
  // like "May 1" when no date anchor is provided.
  return `You are the CFO Agent for ${args.tenantName}, currently running in EDIT MODE.

Today is ${today} (${monthName(m)} ${d}, ${y}). When the user gives a partial date like "May 1" without a year, ALWAYS assume the current year (${y}) unless they explicitly say otherwise.

The user has explicitly enabled edit mode and wants to change a stored value. Every write must go through a confirmation step — never claim a change is applied until the user clicks the Confirm button in the UI.

Hard rules:
  - You can ONLY edit ad_spend_entries, cogs_entries, and manual_revenue_entries.
  - You cannot edit Shopify revenue, subscription revenue, or anything from upstream syncs.
  - You cannot delete rows.
  - You cannot run raw SQL.
  - If the date or amount is missing or ambiguous, ASK — don't guess.
  - Money values are plain numbers (no $ sign, no commas) when you call tools.
  - Date format passed to tools is YYYY-MM-DD. Resolve relative dates (today, yesterday, last Friday, "May 1") against today's date above.

# You CAN write
You DO have write access via the tools attached to this turn. NEVER tell the user "I can't write to the database", "you'll need to enter that manually", "use whatever logging tool you normally use", or anything that suggests you lack write capability. If you cannot perform an edit, it's because of a specific missing detail (which field? which date? what amount?) — ask for that detail, don't claim you can't write at all. The user is in edit mode precisely because writing is what you do here.

Stores:
  - PASS THROUGH the store code exactly as the user wrote it (uppercased), even if it doesn't match a list you remember. Real store names in this workspace might be NOVA_TEST, ELARA_2, or anything else custom — you don't have a list. The server is the source of truth and will return a friendly error if the store isn't part of the user's workspace.
  - NEVER refuse a request because "that's not a valid store code" — only the server makes that call.

# CRITICAL: turn structure

When you call a write tool, you take TWO turns:
  1. The turn where you call the tool — keep this text EMPTY or one ultra-short placeholder like "..." or "one sec". The UI hides this turn entirely, so anything you write here is wasted tokens.
  2. The turn AFTER the tool result — this is what the user sees. Keep it to ONE short sentence pointing at the confirmation card below ("Ready to review below.", "Take a look."). Do NOT repeat the store, date, amount, or "Click Confirm/Cancel" instructions — the card already shows all of that with buttons.

The single biggest mistake to avoid is restating the card's content in your reply. The UI renders the card immediately under your reply text — if you also describe it in prose, the user sees the same information twice.

${args.category.prompt}`;
}

function monthName(m: number): string {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][m - 1] ?? "";
}

/** Convert a Zod schema into the JSON-schema shape Anthropic tools expect.
 *  We hand-build the schemas in each category so this is a minimal
 *  shim — it converts the top-level z.object() shape only. For the
 *  edit categories this is sufficient. */
function zodToToolSchema(_schema: unknown): Anthropic.Tool["input_schema"] {
  // The edit tools all accept the same shape (store_id?, date,
  // new_amount, reason?, revenue_type?). Rather than introspect Zod
  // (which doesn't expose a stable JSON Schema API), we provide a
  // permissive object schema and let Zod itself enforce shape inside
  // each tool's build() function.
  return {
    type: "object",
    properties: {
      store_id: { type: "string", description: "Uppercase store code" },
      date: {
        type: "string",
        description: "YYYY-MM-DD date for the entry",
      },
      new_amount: {
        type: "number",
        description: "New dollar amount (plain number, no $ or commas)",
      },
      reason: {
        type: "string",
        description: "Short note explaining the change (optional)",
      },
      revenue_type: {
        type: "string",
        description:
          "Only for manual revenue edits: e.g. 'coaching', 'consulting'",
      },
    },
    required: ["date", "new_amount"],
  };
}

// ─── Strip echo of confirmation card from assistant reply ──────────────
//
// Even with strict prompt rules, the model occasionally still re-narrates
// the card (e.g. "I've set May 1 NOVA ad spend from $1500 to $2000…").
// When that happens above the rendered card, the user sees the same
// information twice. We post-process the reply: any line that mentions a
// dollar amount that appears in the confirmation payload, OR contains a
// "Confirm/Cancel" instruction, gets dropped. If everything gets dropped
// we substitute a single neutral pointer.
function stripCardEcho(
  reply: string,
  confirmations: Array<{
    after_value: Record<string, unknown>;
    before_value: Record<string, unknown> | null;
    target_pk?: Record<string, unknown>;
  }>,
): string {
  if (!reply.trim()) return "Ready to review below.";

  // Collect the values that already appear on the confirmation card.
  const amounts = new Set<string>();
  const storeIds = new Set<string>();
  const dates = new Set<string>();
  for (const c of confirmations) {
    for (const v of [c.after_value, c.before_value ?? {}, c.target_pk ?? {}]) {
      const row = v as Record<string, unknown>;
      const t = row.total_amount;
      if (typeof t === "number") {
        amounts.add(t.toFixed(2));
        amounts.add(Math.round(t).toString());
      } else if (typeof t === "string") {
        const n = Number(t);
        if (Number.isFinite(n)) {
          amounts.add(n.toFixed(2));
          amounts.add(Math.round(n).toString());
        }
      }
      if (typeof row.store_id === "string") {
        storeIds.add(row.store_id.toUpperCase());
      }
      if (typeof row.date === "string") {
        dates.add(row.date);
        // Also a loose YYYY-MM-DD prefix.
        const m = row.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) dates.add(`${m[1]}-${m[2]}-${m[3]}`);
      }
    }
  }

  // Patterns that always indicate the model is echoing the card.
  const echoMarkers = [
    /\[?\s*pending\s+confirmation\s*\]?/i,
    /\bplease\s+(review|confirm|click)/i,
    /\b(click|press|hit|tap)\s+(the\s+)?(confirm|cancel)/i,
    /\bconfirm\s*\/?\s*cancel\b/i,
    /\bconfirm\s+or\s+cancel\b/i,
    /^\s*(store|date|amount|type|revenue\s*type)\s*[:=]/i,
    /\bmanual\s+revenue\s+entry\b/i,
    /\bcancel\s+this\s+change\b/i,
  ];

  const lines = reply.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed === "..." || trimmed === "…") return false;
    if (echoMarkers.some((rx) => rx.test(trimmed))) return false;

    // Drop lines that quote a dollar value from the card.
    const dollarMatches = trimmed.match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g);
    if (dollarMatches) {
      for (const m of dollarMatches) {
        const n = Number(m.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(n)) continue;
        if (
          amounts.has(n.toFixed(2)) ||
          amounts.has(Math.round(n).toString())
        ) {
          return false;
        }
      }
    }
    // Drop lines that mention a store code from the card.
    if (storeIds.size > 0) {
      const upper = trimmed.toUpperCase();
      for (const sid of storeIds) {
        // Whole-word match to avoid false positives on common words.
        const rx = new RegExp(`\\b${escapeRx(sid)}\\b`);
        if (rx.test(upper)) return false;
      }
    }
    // Drop lines that mention a date string from the card.
    for (const d of dates) {
      if (trimmed.includes(d)) return false;
    }
    return true;
  });
  const result = kept.join("\n").trim();
  return result || "Ready to review below.";
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite/erase any sentence in the reply that falsely tells the user
 *  the agent can't write to the database. The agent CAN write — these
 *  phrases are model hallucinations. We replace them with a neutral
 *  "tell me which field/store/date/amount" prompt. */
function scrubFalseNoWriteClaims(reply: string): string {
  if (!reply) return reply;
  const forbidden = [
    /editing\s+isn['’]?t\s+wired\s+up[^.!?]*[.!?]?/gi,
    /i\s+can['’]?t\s+(log|modify|write|edit|update|change)\s+(entries|data|values)?[^.!?]*[.!?]?/gi,
    /i\s+can['’]?t\s+write\s+to\s+the\s+database[^.!?]*[.!?]?/gi,
    /you['’]?d\s+need\s+to\s+(add|enter|log)\s+that\s+manually[^.!?]*[.!?]?/gi,
    /use\s+whatever\s+(logging\s+)?tool\s+you\s+normally\s+use[^.!?]*[.!?]?/gi,
    /i\s+don['’]?t\s+have\s+(write|edit|update)\s+(access|capability|ability)[^.!?]*[.!?]?/gi,
    /that['’]?s\s+not\s+something\s+i\s+can\s+(do|edit|change)[^.!?]*[.!?]?/gi,
  ];
  let out = reply;
  let scrubbed = false;
  for (const rx of forbidden) {
    if (rx.test(out)) {
      out = out.replace(rx, "");
      scrubbed = true;
    }
  }
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  if (scrubbed && out.length < 30) {
    // If scrubbing left almost nothing, replace with a clear next-step
    // question instead of an empty/awkward reply.
    out = "Which field do you want to change — ad spend, COGS, or a manual revenue entry like coaching? Tell me the store and amount and I'll stage it.";
  } else if (scrubbed) {
    out += "\n\nTell me which field (ad spend, COGS, or manual revenue), store, date, and amount and I'll stage it for you.";
  }
  return out;
}

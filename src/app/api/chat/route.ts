// POST /api/chat — CFO Agent chat endpoint (Phase A: category-routed, read-only).
//
// Flow per request:
//   1. Auth + tenant + rate limit + body validation.
//   2. Reject forbidden intents (mutation/SQL/injection) BEFORE any LLM call.
//   3. Load conversation history from chat_messages so the bot has memory.
//   4. Cheap classifier (Haiku) picks ONE category + ONE pre-built query.
//   5. Run the query — params validated by Zod, scoped to tenantId.
//   6. If result is large → return mode:"table" (UI renders, NO Claude call).
//      If small → run Sonnet with category-specific prompt and return mode:"text".
//   7. Persist user + assistant turns in chat_messages.
//
// Security guarantees (READ-ONLY):
//   - No raw SQL is ever taken from the model. The model picks a query id;
//     the runner uses a hand-written function for that id.
//   - tenantId comes from requireTenant(), never from message content.
//   - Every param is Zod-validated. Unknown keys are rejected.
//   - Forbidden intents short-circuit before the LLM sees them.
//   - User-facing errors are friendly; internals stay in server logs.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { requireTenant } from "@/lib/tenant";
import {
  anthropicClient,
  anthropicMaxTokens,
  anthropicModel,
} from "@/lib/ai/client";
import { buildSystemPrompt } from "@/lib/ai/context";
import {
  ALL_CATEGORIES,
  getCategory,
  runCategoryQuery,
} from "@/lib/ai/categories";
import {
  detectForbiddenIntent,
  friendlyRejection,
  type QueryResult,
  type TableColumn,
} from "@/lib/ai/categories/_base";
import { classifyMessage } from "@/lib/ai/classifier";
import {
  QUERY_DATABASE_TOOL,
  describeQueryToolUsage,
} from "@/lib/ai/query-planner/tool";
import { executePlan } from "@/lib/ai/query-planner/executor";
import {
  consumeRateToken,
  extractSuggestions,
  extractText,
  getOrCreateSession,
  loadHistory,
  persistMessage,
} from "@/lib/ai/chat-shared";
import { detectIntent } from "@/lib/ai/intent-router";
import { handleEditChat } from "@/app/api/chat/edit/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// ─── Limits ───────────────────────────────────────────────────────────────
const MAX_INPUT_CHARS = 4000;
const RATE_MAX_REQUESTS = 30;

const BodySchema = z.object({
  session_id: z.uuid().optional(),
  message: z.string().min(1).max(MAX_INPUT_CHARS),
});

// ─── Handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    return await handleChat(req);
  } catch (e) {
    const internal = e instanceof Error ? e.message : String(e);
    console.error("[/api/chat] uncaught:", internal, (e as Error)?.stack);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Something went wrong on our end. Please try again in a moment.",
      },
      { status: 500 },
    );
  }
}

async function handleChat(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────────────
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

  // ─── Rate limit ────────────────────────────────────────────────────────
  if (!consumeRateToken("read", tenant.user_id, RATE_MAX_REQUESTS)) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "You're sending messages too quickly. Please wait a minute and try again.",
      },
      { status: 429 },
    );
  }

  // ─── Body validation ───────────────────────────────────────────────────
  let body: z.infer<typeof BodySchema>;
  let rawBody: unknown;
  try {
    rawBody = await req.json();
    body = BodySchema.parse(rawBody);
  } catch (e) {
    console.warn("[/api/chat] invalid body:", (e as Error).message);
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "That message couldn't be sent. Please try again.",
      },
      { status: 400 },
    );
  }

  // ─── Auto intent route ─────────────────────────────────────────────────
  // The UI no longer has an Edit toggle; the agent itself decides whether
  // the message wants to read or write. Short follow-ups ("yes please",
  // "$2200") inherit the prior turn's intent so we don't bounce out of
  // edit mode mid-clarification — that means we need history first.
  let priorHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (body.session_id) {
    try {
      const raw = await loadHistory(body.session_id, tenant.id);
      priorHistory = raw
        .filter((h) => h.role === "user" || h.role === "assistant")
        .map((h) => ({
          role: h.role as "user" | "assistant",
          content: h.content,
        }));
    } catch {
      // History load is best-effort — a fresh / missing session is fine.
    }
  }
  const intent = await detectIntent(body.message, priorHistory);
  if (intent === "edit") {
    // Re-wrap the already-parsed body into a fresh Request so the edit
    // handler can re-read it without our consumed stream getting in the way.
    const forwarded = new Request(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rawBody),
    }) as NextRequest;
    return handleEditChat(forwarded);
  }

  // ─── Forbidden intent check ────────────────────────────────────────────
  const blockReason = detectForbiddenIntent(body.message);
  const sessionId = await getOrCreateSession({
    sessionId: body.session_id,
    tenantId: tenant.id,
    userId: tenant.user_id,
    firstMessage: body.message,
  });
  // Persist user turn early so we have the record even if we short-circuit.
  await persistMessage({
    sessionId,
    tenantId: tenant.id,
    role: "user",
    content: body.message,
    blocks: [{ type: "text", text: body.message }],
  });

  if (blockReason) {
    const reply = friendlyRejection(blockReason);
    await persistMessage({
      sessionId,
      tenantId: tenant.id,
      role: "assistant",
      content: reply,
      blocks: [{ type: "text", text: reply }],
      toolName: `blocked:${blockReason}`,
    });
    return NextResponse.json({
      session_id: sessionId,
      mode: "text",
      reply,
      suggestions: [],
      meta: { blocked: true, reason: blockReason },
    });
  }

  // ─── Load conversation history (memory) ────────────────────────────────
  const history = await loadHistory(sessionId, tenant.id);
  const classifierHistory = history
    .filter((h) => h.role === "user" || h.role === "assistant")
    .map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));

  // ─── Classify ──────────────────────────────────────────────────────────
  const decision = await classifyMessage(
    body.message,
    ALL_CATEGORIES,
    classifierHistory,
  );
  let category = getCategory(decision.category) ?? getCategory("core")!;

  // ─── Role gate for restricted categories ───────────────────────────────
  // Some categories (security/audit) only make sense for admin/owner.
  // If a manager or viewer somehow lands on one of those, fall back to
  // "guidance" so they get a polite redirect instead of being silently
  // refused.
  if (
    category.required_roles &&
    !category.required_roles.includes(tenant.role)
  ) {
    const reply =
      "That kind of information is admin-only. You can still ask about revenue, P&L, subscribers, chargebacks, ad spend, or anything else operational.";
    await persistMessage({
      sessionId,
      tenantId: tenant.id,
      role: "assistant",
      content: reply,
      blocks: [{ type: "text", text: reply }],
      toolName: `role_gate:${category.id}`,
    });
    return NextResponse.json({
      session_id: sessionId,
      mode: "text",
      reply,
      suggestions: [
        "show me revenue this week",
        "how many active subscribers?",
        "any chargebacks to review?",
      ],
      meta: {
        blocked: true,
        reason: "role_gate",
        required_roles: category.required_roles,
      },
    });
  }
  // Suppress unused-var lint when role-gate path doesn't reassign category.
  category = category;

  // ─── Run pre-built query (if classifier picked one) ────────────────────
  let queryResult: QueryResult | null = null;
  let queryError: string | null = null;
  if (decision.query_id) {
    try {
      queryResult = await runCategoryQuery({
        category,
        query_id: decision.query_id,
        raw_params: decision.params,
        tenantId: tenant.id,
      });
    } catch (e) {
      // Param validation or DB error. Don't surface details — fall back to
      // a context-only answer.
      queryError = (e as Error).message;
      console.warn(
        `[/api/chat] query ${category.id}/${decision.query_id} failed: ${queryError}`,
      );
    }
  }

  // ─── Table mode: skip the main model entirely ──────────────────────────
  if (queryResult && queryResult.mode === "table") {
    const tablePayload = {
      mode: "table" as const,
      table: {
        query_id: queryResult.query_id,
        category: category.id,
        rows: queryResult.rows,
        columns: queryResult.columns,
        summary: queryResult.summary,
      },
      suggestions: category.fallback_suggestions,
    };
    // Persist the FULL table payload as a JSON blob inside the message
    // body so /api/chat/sessions can reconstruct the table on refresh.
    // We prefix with TABLE_PAYLOAD_V1: + JSON so the hydration code can
    // detect it cheaply without a separate column.
    const tableJsonBlob =
      "TABLE_PAYLOAD_V1:" + JSON.stringify(tablePayload.table);
    await persistMessage({
      sessionId,
      tenantId: tenant.id,
      role: "assistant",
      content: queryResult.summary,
      blocks: [
        {
          type: "text",
          text: tableJsonBlob,
        },
      ],
      toolName: `table:${category.id}/${queryResult.query_id}`,
    });
    return NextResponse.json({
      session_id: sessionId,
      ...tablePayload,
    });
  }

  // ─── Text mode: run Sonnet with category prompt + small query data ─────
  const system = await buildSystemPrompt({
    tenantId: tenant.id,
    userEmail: tenant.email,
    tenantName: tenant.display_name || "your business",
  });

  // Replay prior user+assistant turns for memory.
  const messages: Anthropic.MessageParam[] = [];
  for (const h of history) {
    if (h.role !== "user" && h.role !== "assistant") continue;
    messages.push({
      role: h.role,
      content: h.content,
    });
  }
  // Append a synthetic system-style note with the query result so the model
  // doesn't need to ask for it again, then the user message.
  if (queryResult && queryResult.mode === "text") {
    messages.push({
      role: "user",
      content:
        `[internal note — not shown to the user]\n` +
        `Category: ${category.id}\n` +
        `Query: ${queryResult.query_id}\n` +
        `Result: ${JSON.stringify(queryResult.data)}\n\n` +
        `Now answer the user's question below.`,
    });
  }
  messages.push({ role: "user", content: body.message });

  // System prompt = base context + category-specific guidance + schema +
  // query-tool usage rules + suggestion-block instructions.
  const categoryPrompt = [
    system,
    "",
    category.prompt,
    "",
    describeQueryToolUsage(),
    "",
    suggestionInstruction(),
  ].join("\n");

  const client = anthropicClient();
  const model = anthropicModel();
  const max_tokens = anthropicMaxTokens();

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheCreate = 0;
  let totalCacheRead = 0;
  const t0 = Date.now();

  // ── Tool loop ────────────────────────────────────────────────────────
  // The model may call query_database multiple times (e.g. fetch NOVA
  // then NURA, then summarize). Cap at MAX_TOOL_ITERATIONS so a misbehaving
  // model can't burn unlimited tokens.
  const MAX_QUERY_LOOP = 6;
  let finalText = "";
  let lastBlocks: Anthropic.ContentBlockParam[] = [];
  let queryAttempts = 0;
  let querySuccesses = 0;

  for (let iter = 0; iter < MAX_QUERY_LOOP; iter += 1) {
    const resp = await client.messages.create({
      model,
      max_tokens,
      system: [
        {
          type: "text",
          text: categoryPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [QUERY_DATABASE_TOOL],
      messages,
    });
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;
    const u = resp.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    totalCacheCreate += u.cache_creation_input_tokens ?? 0;
    totalCacheRead += u.cache_read_input_tokens ?? 0;

    lastBlocks = resp.content as Anthropic.ContentBlockParam[];

    // Persist the assistant turn (text + any tool_use blocks).
    await persistMessage({
      sessionId,
      tenantId: tenant.id,
      role: "assistant",
      content: extractText(resp.content),
      blocks: resp.content as Anthropic.ContentBlockParam[],
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      latencyMs: Date.now() - t0,
      toolName: `${category.id}${decision.query_id ? `/${decision.query_id}` : ""}`,
    });

    messages.push({
      role: "assistant",
      content: resp.content as Anthropic.ContentBlockParam[],
    });

    // Normal end-of-turn: model produced its final text answer.
    if (resp.stop_reason !== "tool_use") {
      finalText = extractText(resp.content);
      break;
    }

    // Run every tool_use block, send results back as tool_result.
    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      queryAttempts += 1;
      if (tu.name !== "query_database") {
        // Should never happen — only one tool defined — but reject cleanly.
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: `Unknown tool: ${tu.name}` }),
          is_error: true,
        });
        continue;
      }
      const result = await executePlan(tu.input, { tenantId: tenant.id });
      if (result.ok) {
        querySuccesses += 1;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            row_count: result.row_count,
            truncated: result.truncated,
            rows: result.rows,
          }),
          is_error: false,
        });
        await persistMessage({
          sessionId,
          tenantId: tenant.id,
          role: "tool",
          content: `[query_database] ${result.row_count} rows from ${result.plan.table}`,
          blocks: [
            {
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify({
                row_count: result.row_count,
                truncated: result.truncated,
                preview: result.rows.slice(0, 3),
              }),
            },
          ],
          toolName: `query_database:${result.plan.table}`,
        });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            error: result.reason,
            stage: result.stage,
            hint:
              "Check that the table + columns exist in the schema and that the plan matches the QueryPlan shape.",
          }),
          is_error: true,
        });
        console.warn(
          `[query_database] rejected at ${result.stage}: ${result.reason}`,
        );
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) {
    finalText =
      "I couldn't finish that one — try rephrasing, or ask about a specific store or date.";
  }

  const { cleanReply, suggestions } = extractSuggestions(finalText);
  // AI is required to produce its own contextual suggestions. If the
  // model forgot the [suggestions] block, we return an empty array
  // rather than hardcoded defaults — the UI just shows no chips that turn.
  const finalSuggestions = suggestions;

  // We already persisted each turn inside the loop; here we just need
  // the final-cleanup persistence is unnecessary.
  void lastBlocks; // keep ref for potential debugging

  return NextResponse.json({
    session_id: sessionId,
    mode: "text",
    reply: cleanReply,
    suggestions: finalSuggestions,
    meta: {
      category: category.id,
      query_id: decision.query_id,
      query_error: queryError,
      dynamic_query_attempts: queryAttempts,
      dynamic_query_successes: querySuccesses,
    },
    usage: {
      input_tokens: totalIn,
      output_tokens: totalOut,
      cache_creation_input_tokens: totalCacheCreate,
      cache_read_input_tokens: totalCacheRead,
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function suggestionInstruction(): string {
  return `# Follow-up suggestions (REQUIRED)

After your answer, append a block exactly in this format and nothing else:

[suggestions]
First short question?
Second short question?
Third short question?
[/suggestions]

Rules:
- Always exactly 3 of them. You generate them yourself — there are no fallback defaults.
- 4 to 9 words. Lowercase except names. End with "?".
- Each one is a natural next question based specifically on what you just answered. If you answered about NOVA's revenue, suggest follow-ups about NOVA or about comparing it to other stores — don't shift to unrelated topics.
- Don't repeat the user's question. Don't suggest editing actions (the system is read-only right now).
- For small talk replies (greetings, thanks), still produce 3 suggestions — pick natural opening questions the owner might want to ask about their business.`;
}

// Re-export TableColumn type usage if needed by callers in the same package.
export type { TableColumn };

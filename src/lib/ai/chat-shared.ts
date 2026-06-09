// Shared infrastructure used by both /api/chat (read) and /api/chat/edit
// (edit). Previously both routes had verbatim copies of these helpers,
// which created drift risk every time we touched message persistence.
//
// This module is the single source of truth for:
//   - Per-user rate limit buckets (in-memory; fine for single Vercel
//     instance, swap to Redis later).
//   - Chat session creation + retrieval.
//   - Loading prior message history for the model.
//   - Persisting a single chat_messages row.
//   - Extracting plain text from an Anthropic content-block array.
//
// Nothing in here should be edit-only or read-only — only truly shared
// concerns belong.

import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { anthropicModel } from "@/lib/ai/client";

// ─── Limits ─────────────────────────────────────────────────────────────
export const RATE_WINDOW_MS = 5 * 60 * 1000;

/** Independent buckets keyed by mode + user so a flood of read messages
 *  doesn't lock the user out of edit mode and vice versa. */
const buckets: Record<string, Map<string, number[]>> = {
  read: new Map(),
  edit: new Map(),
  confirm: new Map(),
};

export function consumeRateToken(
  mode: keyof typeof buckets,
  userId: string,
  max: number,
): boolean {
  const now = Date.now();
  const bucket = buckets[mode];
  const arr = bucket.get(userId) ?? [];
  const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= max) {
    bucket.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  bucket.set(userId, fresh);
  return true;
}

// ─── Text extraction ───────────────────────────────────────────────────
export function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ─── Session helpers ───────────────────────────────────────────────────
export async function getOrCreateSession(args: {
  sessionId?: string;
  tenantId: string;
  userId: string;
  firstMessage: string;
}): Promise<string> {
  const sb = supabaseAdmin();
  if (args.sessionId) {
    const { data } = await sb
      .from("chat_sessions")
      .select("id")
      .eq("id", args.sessionId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle();
    if (data?.id) return data.id;
    // Session id supplied but missing/wrong tenant — fall through and
    // create a new session so the user isn't stuck.
  }
  const title = args.firstMessage.slice(0, 80);
  const { data, error } = await sb
    .from("chat_sessions")
    .insert({
      tenant_id: args.tenantId,
      user_id: args.userId,
      title,
      model: anthropicModel(),
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `getOrCreateSession: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

// ─── History loader ────────────────────────────────────────────────────
export type StoredMsg = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name: string | null;
};

export const MAX_HISTORY_TURNS = 40;

export async function loadHistory(
  sessionId: string,
  tenantId: string,
): Promise<StoredMsg[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("chat_messages")
    .select("role, content, tool_name, created_at")
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY_TURNS);
  if (error) throw new Error(`loadHistory: ${error.message}`);
  return (data ?? []) as StoredMsg[];
}

// ─── Persist a single message row ──────────────────────────────────────
export async function persistMessage(args: {
  sessionId: string;
  tenantId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  blocks: Anthropic.ContentBlockParam[] | null;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  toolName?: string | null;
}): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.from("chat_messages").insert({
    session_id: args.sessionId,
    tenant_id: args.tenantId,
    role: args.role,
    content: args.content,
    blocks: args.blocks,
    input_tokens: args.inputTokens ?? null,
    output_tokens: args.outputTokens ?? null,
    latency_ms: args.latencyMs ?? null,
    tool_name: args.toolName ?? null,
  });
  if (error) throw new Error(`persistMessage: ${error.message}`);
}

// ─── Suggestion block parsing ──────────────────────────────────────────
/** AI is told to append a `[suggestions]…[/suggestions]` block. We split
 *  it off so the chat thread shows clean prose and the suggestion chips
 *  render separately. */
export function extractSuggestions(text: string): {
  cleanReply: string;
  suggestions: string[];
} {
  const match = text.match(/\[suggestions\]([\s\S]*?)\[\/suggestions\]/i);
  if (!match) return { cleanReply: text.trim(), suggestions: [] };
  const block = match[1];
  const suggestions = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3); // prompt asks for exactly 3
  const cleanReply = text.replace(match[0], "").trim();
  return { cleanReply, suggestions };
}

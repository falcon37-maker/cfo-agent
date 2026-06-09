// GET /api/chat/sessions
// Returns the caller's recent chat sessions (most recent first) + the messages
// for an optional ?session_id=... param.
//
// Auth-gated through requireTenant(); never exposes another tenant's data.

import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    return await handleSessions(req);
  } catch (e) {
    console.error("[/api/chat/sessions] uncaught:", e);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't load chat history. Please try again.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
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

    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) {
      return NextResponse.json(
        {
          error: "missing_param",
          message: "Missing session id.",
        },
        { status: 400 },
      );
    }

    const sb = supabaseAdmin();
    const { error } = await sb
      .from("chat_sessions")
      .delete()
      .eq("id", sessionId)
      .eq("tenant_id", tenant.id);
    if (error) {
      console.error("[/api/chat/sessions] delete:", error.message);
      return NextResponse.json(
        {
          error: "internal_error",
          message: "Couldn't delete that conversation. Please try again.",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/chat/sessions] DELETE uncaught:", e);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't delete that conversation. Please try again.",
      },
      { status: 500 },
    );
  }
}

async function handleSessions(req: NextRequest) {
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

  const sb = supabaseAdmin();
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");

  const { data: sessions, error: sErr } = await sb
    .from("chat_sessions")
    .select("id, title, message_count, last_message_at, created_at")
    .eq("tenant_id", tenant.id)
    .order("last_message_at", { ascending: false })
    .limit(20);
  if (sErr) {
    console.error("[/api/chat/sessions] sessions query:", sErr.message);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't load chat history. Please try again.",
      },
      { status: 500 },
    );
  }

  // Derive a friendly first-name for the greeting from tenant display_name
  // or email local-part. Falls back to empty string so the UI can choose
  // its own default.
  const userName = deriveFirstName(
    tenant.display_name,
    tenant.email,
  );

  type StoredMsg = {
    id: string;
    role: string;
    content: string;
    tool_name: string | null;
    created_at: string;
  };
  type HydratedConfirmation = {
    pending_id: string;
    tool_name: string;
    target_table: string;
    target_pk: Record<string, unknown>;
    before_value: Record<string, unknown> | null;
    after_value: Record<string, unknown>;
    human_summary: string;
    status: "pending" | "confirmed" | "cancelled" | "expired";
    created_at: string;
  };
  // Table payload structure persisted by /api/chat for mode:"table" replies.
  type HydratedTable = {
    query_id: string;
    category: string;
    rows: Record<string, unknown>[];
    columns: Array<{
      key: string;
      label: string;
      format?: "money" | "pct" | "date" | "int" | "text";
    }>;
    summary: string;
  };
  let messages: Array<
    StoredMsg & {
      suggestions?: string[];
      confirmations?: HydratedConfirmation[];
      table?: HydratedTable;
    }
  > = [];
  if (sessionId) {
    const { data: msgs, error: mErr } = await sb
      .from("chat_messages")
      .select("id, role, content, tool_name, created_at")
      .eq("tenant_id", tenant.id)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (mErr) {
      console.error("[/api/chat/sessions] messages query:", mErr.message);
      return NextResponse.json(
        {
          error: "internal_error",
          message: "Couldn't load messages. Please try again.",
        },
        { status: 500 },
      );
    }

    // Pull pending_confirmations for this session so the UI can re-render
    // historical confirm cards (with their final status) after a refresh.
    // We attach each confirmation to the closest preceding assistant
    // message by timestamp — that's where the card was originally shown.
    const { data: confRows } = await sb
      .from("pending_confirmations")
      .select(
        "id, tool_name, target_table, target_pk, before_value, after_value, human_summary, status, created_at",
      )
      .eq("tenant_id", tenant.id)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    // Drop intermediate edit-flow assistant turns (the ones that only
    // contained a tool_use block + filler text like "Staging that
    // update now"). The post-tool-result turn is the one the user
    // actually wants to see.
    const allMsgs = ((msgs ?? []) as StoredMsg[]).filter(
      (m) => !(m.tool_name ?? "").startsWith("intermediate:"),
    );

    // Build the message list with suggestions split out + table payload
    // restored when the message body carries a TABLE_PAYLOAD_V1 marker.
    const hydrated: Array<
      StoredMsg & {
        suggestions?: string[];
        confirmations?: HydratedConfirmation[];
        table?: HydratedTable;
      }
    > = allMsgs.map((m) => {
      if (m.role !== "assistant") return m;
      // Table-mode messages are stored with TABLE_PAYLOAD_V1:{json} in
      // content. Detect, parse, and surface as a structured `table` field.
      if (m.content.startsWith("TABLE_PAYLOAD_V1:")) {
        try {
          const json = m.content.slice("TABLE_PAYLOAD_V1:".length);
          const table = JSON.parse(json) as HydratedTable;
          return {
            ...m,
            content: table.summary ?? "",
            table,
          };
        } catch {
          // If parsing fails, fall through to plain-text handling.
        }
      }
      const { cleanReply, suggestions } = splitSuggestions(m.content);
      return { ...m, content: cleanReply, suggestions };
    });

    // Attach each confirmation to the FIRST assistant message that comes
    // after its created_at. This is the post-tool-result reply (since the
    // intermediate tool_use turn is already filtered out above). If none
    // exists, fall back to the closest preceding assistant message —
    // covers edge cases where staging finished but the final reply hasn't
    // been persisted yet (rare race).
    type RawConf = {
      id: string;
      tool_name: string;
      target_table: string;
      target_pk: Record<string, unknown>;
      before_value: Record<string, unknown> | null;
      after_value: Record<string, unknown>;
      human_summary: string;
      status: HydratedConfirmation["status"];
      created_at: string;
    };
    for (const c of (confRows ?? []) as RawConf[]) {
      const cTime = new Date(c.created_at).getTime();
      // Prefer: first assistant message >= cTime.
      let targetIdx = hydrated.findIndex(
        (m) =>
          m.role === "assistant" &&
          new Date(m.created_at).getTime() >= cTime - 1000,
      );
      // Fallback: nearest preceding assistant message.
      if (targetIdx === -1) {
        for (let i = 0; i < hydrated.length; i += 1) {
          if (hydrated[i].role === "assistant") {
            if (new Date(hydrated[i].created_at).getTime() <= cTime) {
              targetIdx = i;
            }
          }
        }
      }
      if (targetIdx === -1) continue;
      const target = hydrated[targetIdx];
      if (!target.confirmations) target.confirmations = [];
      target.confirmations.push({
        pending_id: c.id,
        tool_name: c.tool_name,
        target_table: c.target_table,
        target_pk: c.target_pk,
        before_value: c.before_value,
        after_value: c.after_value,
        human_summary: c.human_summary,
        status: c.status,
        created_at: c.created_at,
      });
    }

    messages = hydrated;
  }

  return NextResponse.json({
    sessions: sessions ?? [],
    messages,
    user_name: userName,
  });
}

// Pull a friendly first name for the greeting. Order of preference:
//   1. First word of tenant.display_name (e.g. "Tayyab Hassan" → "Tayyab")
//   2. Local part of email up to first . or _ (e.g. "tayyab.h@x.com" → "Tayyab")
//   3. Empty string — UI shows a generic greeting.
function deriveFirstName(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string {
  const dn = (displayName ?? "").trim();
  if (dn) {
    const first = dn.split(/\s+/)[0];
    // Skip generic placeholders like "manager" or company-style names.
    if (first && first.length >= 2 && /^[A-Za-z][A-Za-z'-]*$/.test(first)) {
      return capitalize(first);
    }
  }
  const e = (email ?? "").trim().toLowerCase();
  if (e.includes("@")) {
    const local = e.split("@")[0];
    const token = local.split(/[._\-+]/)[0];
    if (token && token.length >= 2 && /^[a-z]/.test(token)) {
      return capitalize(token);
    }
  }
  return "";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Mirror of extractSuggestions() in /api/chat/route.ts — pulls a
 *  `[suggestions]…[/suggestions]` block off a stored assistant message so
 *  the UI can render it as chips when history is reloaded. */
function splitSuggestions(text: string): {
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
    .slice(0, 4);
  const cleanReply = text.replace(match[0], "").trim();
  return { cleanReply, suggestions };
}

"use client";

// CFO Agent chat — right-side drawer with tabbed Chat / History view.
//
// Layout when open:
//   ┌────────────────────────────────────────┐
//   │ [Chat] [History]      [✎] [↓] [×]      │  tabs + actions
//   ├────────────────────────────────────────┤
//   │                                        │
//   │            ✦ CFO AGENT                 │  brand
//   │                                        │
//   │       Hello {Name} 👋                  │  greeting
//   │     How can I help you today?          │
//   │                                        │
//   │  ┌──────────────────────────────────┐  │
//   │  │ How is revenue this week?        │  │  suggestion cards
//   │  └──────────────────────────────────┘  │
//   │  ┌──────────────────────────────────┐  │
//   │  │ Active subscribers               │  │
//   │  └──────────────────────────────────┘  │
//   │  ...                                   │
//   │                                        │
//   ├────────────────────────────────────────┤
//   │  ╭────────────────────────╮       ⬤   │  input pill + send
//   │  │ Ask anything…          │           │
//   │  ╰────────────────────────╯           │
//   │  CFO Agent can make mistakes.          │  disclaimer
//   └────────────────────────────────────────┘
//
// Tabs swap the body between the active chat thread and a list of past
// conversations. History rows open back into the Chat tab. The empty-chat
// screen shows the welcome state with personalized suggestions.

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TableMessage, type TableData } from "./TableMessage";
import {
  ConfirmEditCard,
  type PendingConfirmation,
} from "./ConfirmEditCard";
import {
  MessageSquare,
  Send,
  X,
  Pencil,
  Download,
  Trash2,
  Sparkles,
  FileText,
} from "lucide-react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_name?: string | null;
  /** Follow-up question chips parsed out of the assistant reply. */
  suggestions?: string[];
  /** When the backend returned mode:"table", the structured data lives here.
   *  In that case `content` holds the human-readable summary only. */
  table?: TableData | null;
  /** Edit-mode only: pending confirmations to render as cards under
   *  this assistant turn. */
  confirmations?: PendingConfirmation[];
};

type SessionRow = {
  id: string;
  title: string | null;
  message_count: number;
  last_message_at: string;
  created_at: string;
};

const STORAGE_SESSION = "cfo-agent.chat.session_id";
const STORAGE_OPEN = "cfo-agent.chat.drawer_open";

type Tab = "chat" | "history";

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** Ref mirror of `sending` so a fast double-Enter can't fire two
   *  requests during React's state-batching delay. */
  const sendingRef = useRef(false);
  /** AbortController for the in-flight send/hydrate fetch. Aborted on
   *  session switch, drawer close, or component unmount so a stale
   *  response never lands in the wrong session. */
  const sendAbortRef = useRef<AbortController | null>(null);
  const hydrateAbortRef = useRef<AbortController | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // ─── Hydrate from localStorage on mount ───────────────────────────────
  useEffect(() => {
    try {
      const sid = localStorage.getItem(STORAGE_SESSION);
      if (sid) setSessionId(sid);
      const wasOpen = localStorage.getItem(STORAGE_OPEN);
      if (wasOpen === "1") setOpen(true);
    } catch {
      // ignore
    }
  }, []);

  // Persist open state.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open]);

  // ─── Load session list (also captures user_name for greeting) ─────────
  const loadSessionList = useCallback(async () => {
    try {
      const r = await fetch("/api/chat/sessions");
      const raw = await r.text();
      if (!r.ok || !raw) return;
      const data = JSON.parse(raw) as {
        sessions?: SessionRow[];
        user_name?: string;
      };
      if (Array.isArray(data.sessions)) setSessions(data.sessions);
      if (typeof data.user_name === "string") setUserName(data.user_name);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    if (open) void loadSessionList();
  }, [open, loadSessionList]);

  // ─── Hydrate messages when session changes ────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (!sessionId) {
      setMessages([]);
      return;
    }
    // Cancel any in-flight hydrate before starting a new one. Without
    // this, switching sessions fast can make a stale response overwrite
    // the active session's messages.
    hydrateAbortRef.current?.abort();
    const ctrl = new AbortController();
    hydrateAbortRef.current = ctrl;

    setHydrating(true);
    fetch(`/api/chat/sessions?session_id=${encodeURIComponent(sessionId)}`, {
      signal: ctrl.signal,
    })
      .then((r) => r.text())
      .then((raw) => {
        if (ctrl.signal.aborted || !raw) return;
        try {
          const data = JSON.parse(raw) as { messages?: ChatMessage[] };
          if (Array.isArray(data.messages)) {
            setMessages(data.messages.filter((m) => m.role !== "tool"));
          }
        } catch {
          // ignore
        }
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") {
          // Non-fatal — older sessions sometimes 404; user can start fresh.
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setHydrating(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [open, sessionId]);

  // Abort any in-flight requests on unmount.
  useEffect(() => {
    return () => {
      sendAbortRef.current?.abort();
      hydrateAbortRef.current?.abort();
    };
  }, []);

  // ─── Smart auto-scroll ────────────────────────────────────────────────
  // We only auto-scroll when (a) the user is already near the bottom
  // (within 80px) or (b) the most recent message was just sent by the
  // user. This keeps confirmation cards visible when the user has
  // scrolled up to read them, instead of yanking them back to the
  // bottom on every state change.
  const lastMessageCountRef = useRef(0);
  useEffect(() => {
    if (!open || tab !== "chat") return;
    const el = scrollRef.current;
    if (!el) return;
    const prevCount = lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;
    const lastMsg = messages[messages.length - 1];
    const userJustSent = lastMsg?.role === "user";
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (
      messages.length > prevCount &&
      (userJustSent || nearBottom)
    ) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, open, tab]);

  // ─── Focus input when drawer opens ────────────────────────────────────
  useEffect(() => {
    if (open && tab === "chat") {
      const t = setTimeout(() => inputRef.current?.focus(), 200);
      return () => clearTimeout(t);
    }
  }, [open, tab]);

  // ─── Send a message ───────────────────────────────────────────────────
  const send = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      // Ref-based gate — React state batching can delay `sending=true`
      // by a tick, letting a fast double-Enter fire two requests.
      if (!text || sendingRef.current) return;
      sendingRef.current = true;
      setError(null);
      setSending(true);
      setTab("chat");

      const userMsg: ChatMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        content: text,
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");

      // Cancel any in-flight previous send before starting a new one.
      sendAbortRef.current?.abort();
      const ctrl = new AbortController();
      sendAbortRef.current = ctrl;
      const requestSessionId = sessionId; // capture for stale-response check

      try {
        // Single endpoint — /api/chat detects edit intent server-side and
        // transparently forwards to the edit pipeline when needed. The
        // unified response shape covers both:
        //   { mode, reply, table?, suggestions?, confirmations? }
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId ?? undefined,
            message: text,
          }),
          signal: ctrl.signal,
        });
        // Drop responses that belong to a session the user already left
        // (e.g. opened a different history row while this fetch was in-flight).
        if (ctrl.signal.aborted) return;
        const raw = await r.text();
        if (ctrl.signal.aborted) return;
        let data: {
          session_id?: string;
          mode?: "text" | "table";
          reply?: string;
          message?: string;
          suggestions?: string[];
          table?: TableData;
          confirmations?: PendingConfirmation[];
        } = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = {};
          }
        }
        if (!r.ok) {
          const friendly =
            data.message ||
            (r.status === 401
              ? "Your session expired. Please refresh and sign in again."
              : r.status === 403
                ? "Your role doesn't allow edits."
                : r.status === 429
                  ? "You're sending messages too quickly. Please wait a minute and try again."
                  : "Something went wrong. Please try again.");
          throw new Error(friendly);
        }
        // If the user switched sessions while we were waiting, discard the
        // response so it doesn't appear in the wrong thread.
        if (requestSessionId !== sessionId && sessionId !== null) return;
        if (data.session_id && data.session_id !== sessionId) {
          setSessionId(data.session_id);
          try {
            localStorage.setItem(STORAGE_SESSION, data.session_id);
          } catch {
            // ignore
          }
        }
        const isTable = data.mode === "table" && data.table != null;
        const confirmations = Array.isArray(data.confirmations)
          ? data.confirmations
          : [];
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}-r`,
            role: "assistant",
            content: isTable
              ? data.table!.summary
              : (data.reply ?? ""),
            table: isTable ? data.table! : null,
            confirmations: confirmations.length > 0 ? confirmations : undefined,
            suggestions: Array.isArray(data.suggestions)
              ? data.suggestions
              : [],
          },
        ]);
        void loadSessionList();
      } catch (e) {
        // AbortError = the user navigated/closed mid-request. Not user-facing.
        const err = e as Error;
        if (err.name === "AbortError") return;
        setError(err.message);
      } finally {
        // Only clear the flag if this controller is still the active one —
        // otherwise we'd flip `sending` off for a newer in-flight request.
        if (sendAbortRef.current === ctrl) {
          sendingRef.current = false;
          setSending(false);
          sendAbortRef.current = null;
        }
      }
    },
    [input, sessionId, loadSessionList],
  );

  // ─── New conversation ─────────────────────────────────────────────────
  const newConversation = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setError(null);
    setTab("chat");
    try {
      localStorage.removeItem(STORAGE_SESSION);
    } catch {
      // ignore
    }
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // ─── Switch session from history ──────────────────────────────────────
  const switchSession = useCallback((id: string) => {
    setSessionId(id);
    setError(null);
    setTab("chat");
    try {
      localStorage.setItem(STORAGE_SESSION, id);
    } catch {
      // ignore
    }
  }, []);

  // ─── Delete session ───────────────────────────────────────────────────
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/chat/sessions?session_id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      } catch {
        // ignore
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === sessionId) newConversation();
    },
    [sessionId, newConversation],
  );

  // ─── Export current conversation as Markdown ──────────────────────────
  const exportChat = useCallback(() => {
    if (messages.length === 0) return;
    const lines: string[] = [
      `# CFO Agent — Conversation Export`,
      `_${new Date().toLocaleString()}_`,
      "",
    ];
    for (const m of messages) {
      lines.push(`## ${m.role === "user" ? "You" : "Agent"}`);
      lines.push("");
      if (m.content) {
        lines.push(m.content);
        lines.push("");
      }
      // Table reply — render columns/rows as a GitHub-flavored MD table.
      if (m.table && Array.isArray(m.table.rows) && m.table.rows.length > 0) {
        const cols = m.table.columns ?? [];
        if (cols.length > 0) {
          lines.push(`| ${cols.map((c) => c.label).join(" | ")} |`);
          lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
          for (const row of m.table.rows) {
            lines.push(
              `| ${cols
                .map((c) => {
                  const v = (row as Record<string, unknown>)[c.key];
                  return v == null ? "" : String(v).replace(/\|/g, "\\|");
                })
                .join(" | ")} |`,
            );
          }
          lines.push("");
        }
      }
      // Edit confirmations — note status so the export reflects history.
      if (m.confirmations && m.confirmations.length > 0) {
        for (const c of m.confirmations) {
          const status = c.status ?? "pending";
          lines.push(`> **Edit (${status}):** ${c.human_summary}`);
        }
        lines.push("");
      }
      // Suggestion chips.
      if (m.suggestions && m.suggestions.length > 0) {
        lines.push("_Follow-ups:_");
        for (const s of m.suggestions) lines.push(`- ${s}`);
        lines.push("");
      }
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cfo-agent-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [messages]);

  // ─── Clear all conversations ──────────────────────────────────────────
  const clearAllSessions = useCallback(async () => {
    if (sessions.length === 0) return;
    if (!confirm("Delete all conversations? This cannot be undone.")) return;
    const ids = sessions.map((s) => s.id);
    await Promise.all(
      ids.map((id) =>
        fetch(
          `/api/chat/sessions?session_id=${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ).catch(() => null),
      ),
    );
    setSessions([]);
    newConversation();
  }, [sessions, newConversation]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // Resize the textarea to fit its content (single-line baseline → growing
  // up to the CSS max-height). Runs on every input change and whenever the
  // value is cleared after a send.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const showEmpty = messages.length === 0 && !hydrating && !sending;

  return (
    <>
      {/* Toggle pill */}
      {!open && (
        <button
          type="button"
          aria-label="Open CFO Agent chat"
          onClick={() => setOpen(true)}
          className="cfo-toggle"
        >
          <MessageSquare size={16} />
          <span>CFO Agent</span>
        </button>
      )}

      {/* Backdrop */}
      {open && (
        <div
          className="cfo-backdrop"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Drawer */}
      <aside
        className={`cfo-drawer ${open ? "open" : ""}`}
        role="dialog"
        aria-label="CFO Agent chat"
        aria-hidden={!open}
      >
        {/* ─── Top bar: tabs + actions ──────────────────────────────── */}
        <div className="cfo-topbar">
          <div className="cfo-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              className={`cfo-tab ${tab === "chat" ? "active" : ""}`}
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "history"}
              className={`cfo-tab ${tab === "history" ? "active" : ""}`}
              onClick={() => setTab("history")}
            >
              History
            </button>
          </div>
          <div className="cfo-actions">
            <button
              type="button"
              className="cfo-icon-btn"
              onClick={newConversation}
              title="New conversation"
              aria-label="New conversation"
            >
              <Pencil size={15} />
            </button>
            <button
              type="button"
              className="cfo-icon-btn"
              onClick={exportChat}
              disabled={messages.length === 0}
              title="Export conversation"
              aria-label="Export conversation"
            >
              <Download size={15} />
            </button>
            <button
              type="button"
              className="cfo-icon-btn"
              onClick={() => setOpen(false)}
              title="Close"
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* ─── Body ─────────────────────────────────────────────────── */}
        {tab === "chat" ? (
          <div className="cfo-pane">
            <div ref={scrollRef} className="cfo-scroll">
              {hydrating && messages.length === 0 && (
                <div className="cfo-loading">Loading conversation…</div>
              )}

              {showEmpty && (
                <div className="cfo-welcome">
                  <div className="cfo-brand">
                    <Sparkles size={18} className="cfo-brand-icon" />
                    <span className="cfo-brand-name">CFO AGENT</span>
                    <span className="cfo-brand-pill">AI</span>
                  </div>
                  <h2 className="cfo-greeting">
                    Hello {userName || "there"}{" "}
                    <span className="cfo-wave" aria-hidden>
                      👋
                    </span>
                  </h2>
                  <p className="cfo-subgreeting">
                    How can I help you today?
                  </p>
                  <div className="cfo-suggestions">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="cfo-suggestion"
                        onClick={() => void send(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.length > 0 && (
                <div
                  className="cfo-messages"
                  role="log"
                  aria-live="polite"
                  aria-label="Chat conversation"
                >
                  {/* Drop empty assistant turns. The model emits one such
                      turn per tool call (text block is empty, only a
                      tool_use block exists); we don't want to render a
                      blank bubble for it. */}
                  {messages
                    .filter(
                      (m) =>
                        m.role !== "assistant" ||
                        (m.content && m.content.trim().length > 0),
                    )
                    .map((m, idx, arr) => {
                      const isLastAssistant =
                        m.role === "assistant" &&
                        idx === arr.length - 1 &&
                        !sending;
                      const hasSuggestions =
                        isLastAssistant &&
                        Array.isArray(m.suggestions) &&
                        m.suggestions.length > 0;
                      return (
                        <div key={m.id} className={`cfo-msg cfo-msg-${m.role}`}>
                          {m.role === "assistant" && m.table ? (
                            // Table mode: skip the bubble chrome and let the
                            // TableMessage component own its own framing.
                            <TableMessage table={m.table} />
                          ) : (
                            <div className="cfo-msg-bubble">
                              {m.role === "assistant" ? (
                                <div className="cfo-md">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {m.content}
                                  </ReactMarkdown>
                                </div>
                              ) : (
                                <div className="cfo-msg-plain">{m.content}</div>
                              )}
                            </div>
                          )}
                          {Array.isArray(m.confirmations) &&
                            m.confirmations.length > 0 && (
                              <div className="cfo-confirmations">
                                {m.confirmations.map((conf) => (
                                  <ConfirmEditCard
                                    key={conf.pending_id}
                                    confirmation={conf}
                                    onResolved={(res) => {
                                      // Append a small status line to the
                                      // chat thread once the user resolves
                                      // the card. Keeps the conversation
                                      // narrative clean.
                                      const note = res.applied
                                        ? `Applied: ${res.summary}`
                                        : res.cancelled
                                          ? `Cancelled: ${res.summary}`
                                          : `Couldn't apply: ${res.error ?? "failed"}`;
                                      setMessages((prev) => [
                                        ...prev,
                                        {
                                          id: `local-${Date.now()}-status`,
                                          role: "system",
                                          content: note,
                                        },
                                      ]);
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                          {hasSuggestions && (
                            <div className="cfo-followups">
                              {m.suggestions!.map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  className="cfo-followup-chip"
                                  onClick={() => void send(s)}
                                  disabled={sending}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {sending && (
                    <div className="cfo-msg cfo-msg-assistant">
                      <div className="cfo-msg-bubble cfo-typing-bubble">
                        <span className="cfo-typing-dot" />
                        <span className="cfo-typing-dot" />
                        <span className="cfo-typing-dot" />
                      </div>
                    </div>
                  )}
                  {error && (
                    <div
                      className="cfo-error"
                      role="alert"
                      aria-live="assertive"
                    >
                      {error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="cfo-input-wrap">
              <form
                className="cfo-input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Ask anything or describe a change…"
                  disabled={sending}
                  maxLength={4000}
                  rows={1}
                />
                <button
                  type="submit"
                  disabled={sending || !input.trim()}
                  aria-label="Send"
                  className="cfo-send-btn"
                >
                  <Send size={15} />
                </button>
              </form>
              <div className="cfo-disclaimer">
                CFO Agent can make mistakes. Double-check replies.
              </div>
            </div>
          </div>
        ) : (
          <div className="cfo-pane">
            <div className="cfo-scroll">
              <div className="cfo-history-head">
                <div className="cfo-brand">
                  <Sparkles size={18} className="cfo-brand-icon" />
                  <span className="cfo-brand-name">CFO AGENT</span>
                  <span className="cfo-brand-pill">AI</span>
                </div>
                <h2 className="cfo-history-title-h">Chat History</h2>
                <p className="cfo-history-sub">Your previous conversations</p>
              </div>

              <div className="cfo-history-toolbar">
                <div className="cfo-history-count">
                  Recent Chats ({sessions.length})
                </div>
                <button
                  type="button"
                  className="cfo-clear-all"
                  onClick={() => void clearAllSessions()}
                  disabled={sessions.length === 0}
                >
                  <Trash2 size={13} />
                  <span>Clear All</span>
                </button>
              </div>

              {sessions.length === 0 ? (
                <div className="cfo-history-empty">
                  <div className="cfo-history-empty-icon" aria-hidden>
                    <FileText size={32} />
                  </div>
                  <div className="cfo-history-empty-text">
                    No conversations yet
                  </div>
                </div>
              ) : (
                <div className="cfo-history-list">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`cfo-history-row ${
                        s.id === sessionId ? "active" : ""
                      }`}
                      onClick={() => switchSession(s.id)}
                    >
                      <div className="cfo-history-row-icon">
                        <MessageSquare size={14} />
                      </div>
                      <div className="cfo-history-row-body">
                        <div className="cfo-history-row-title">
                          {s.title ?? "Untitled"}
                        </div>
                        <div className="cfo-history-row-meta">
                          {s.message_count} messages · {formatDate(s.last_message_at)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="cfo-history-row-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteSession(s.id);
                        }}
                        title="Delete conversation"
                        aria-label="Delete conversation"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="cfo-input-wrap">
              <form
                className="cfo-input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Ask anything or describe a change…"
                  disabled={sending}
                  maxLength={4000}
                  rows={1}
                />
                <button
                  type="submit"
                  disabled={sending || !input.trim()}
                  aria-label="Send"
                  className="cfo-send-btn"
                >
                  <Send size={15} />
                </button>
              </form>
              <div className="cfo-disclaimer">
                CFO Agent can make mistakes. Double-check replies.
              </div>
            </div>
          </div>
        )}
      </aside>

      <style jsx global>{`
        /* ─── Toggle pill ────────────────────────────────────────── */
        .cfo-toggle {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 998;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          border-radius: 999px;
          background: var(--accent);
          color: var(--on-accent);
          border: none;
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
          transition: transform 0.15s ease, background 0.15s ease;
        }
        .cfo-toggle:hover {
          transform: translateY(-1px);
          background: var(--accent-strong);
        }

        /* ─── Backdrop ──────────────────────────────────────────── */
        .cfo-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.25);
          z-index: 998;
          animation: cfoFadeIn 0.18s ease;
        }
        @keyframes cfoFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        /* ─── Drawer ────────────────────────────────────────────── */
        .cfo-drawer {
          position: fixed;
          top: 0;
          right: 0;
          height: 100vh;
          width: min(480px, 100vw);
          background: var(--surface);
          border-left: 1px solid var(--border);
          box-shadow: -16px 0 48px rgba(0, 0, 0, 0.25);
          z-index: 999;
          display: flex;
          flex-direction: column;
          transform: translateX(100%);
          transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .cfo-drawer.open {
          transform: translateX(0);
        }

        /* ─── Top bar (tabs + actions) ───────────────────────────── */
        .cfo-topbar {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border);
        }
        .cfo-tabs {
          display: inline-flex;
          gap: 6px;
          background: var(--surface-2);
          padding: 4px;
          border-radius: 999px;
        }
        .cfo-tab {
          background: transparent;
          border: none;
          color: var(--text-dim);
          font-size: 12.5px;
          font-weight: 600;
          padding: 6px 16px;
          border-radius: 999px;
          cursor: pointer;
          transition: background 0.12s, color 0.12s;
          font-family: var(--font-sans), sans-serif;
        }
        .cfo-tab:hover {
          color: var(--text);
        }
        .cfo-tab.active {
          background: var(--text);
          color: var(--surface);
        }
        .cfo-actions {
          display: inline-flex;
          gap: 4px;
        }
        .cfo-icon-btn {
          background: transparent;
          border: none;
          color: var(--text-dim);
          width: 30px;
          height: 30px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background 0.12s, color 0.12s;
        }
        .cfo-icon-btn:hover:not(:disabled) {
          background: var(--surface-3);
          color: var(--text);
        }
        .cfo-icon-btn:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }

        /* ─── Chat pane ─────────────────────────────────────────── */
        .cfo-pane {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .cfo-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 24px 20px;
        }
        .cfo-loading {
          color: var(--muted);
          font-size: 13px;
          text-align: center;
          padding: 24px;
        }

        /* ─── Welcome / empty state ──────────────────────────────── */
        .cfo-welcome {
          padding: 24px 4px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }
        .cfo-brand {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 28px;
        }
        .cfo-brand-icon {
          color: var(--accent);
        }
        .cfo-brand-name {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.18em;
          color: var(--text);
        }
        .cfo-brand-pill {
          font-size: 10px;
          font-weight: 700;
          background: var(--text);
          color: var(--surface);
          padding: 3px 8px;
          border-radius: 6px;
          letter-spacing: 0.05em;
        }
        .cfo-greeting {
          font-size: 26px;
          font-weight: 700;
          color: var(--text);
          margin: 0 0 6px;
          line-height: 1.2;
        }
        .cfo-wave {
          display: inline-block;
          font-size: 22px;
          margin-left: 4px;
        }
        .cfo-subgreeting {
          font-size: 14px;
          color: var(--text-dim);
          margin: 0 0 24px;
        }
        .cfo-suggestions {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .cfo-suggestion {
          text-align: left;
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 14px 18px;
          border-radius: 14px;
          font-size: 13.5px;
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s, transform 0.08s;
          font-family: var(--font-sans), sans-serif;
        }
        .cfo-suggestion:hover {
          background: var(--surface-2);
          border-color: var(--border-strong);
        }
        .cfo-suggestion:active {
          transform: scale(0.99);
        }

        /* ─── Messages ──────────────────────────────────────────── */
        .cfo-messages {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .cfo-msg {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .cfo-msg-user {
          align-items: flex-end;
        }
        .cfo-msg-bubble {
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 13.5px;
          line-height: 1.6;
          max-width: 90%;
        }
        .cfo-msg-user .cfo-msg-bubble {
          background: var(--accent-bg-strong);
          color: var(--text);
          border: 1px solid var(--accent-dim);
        }
        .cfo-msg-assistant .cfo-msg-bubble {
          background: var(--surface-2);
          color: var(--text);
          border: 1px solid var(--border);
        }
        .cfo-msg-plain {
          white-space: pre-wrap;
          word-wrap: break-word;
        }

        /* ─── Confirmation card container (edit mode) ───────────── */
        .cfo-confirmations {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 10px;
        }

        /* ─── System messages (status lines after confirm/cancel) ── */
        .cfo-msg-system .cfo-msg-bubble {
          background: transparent;
          border: 1px dashed var(--border);
          color: var(--muted-strong);
          font-size: 12px;
          font-style: italic;
          padding: 6px 12px;
        }

        .cfo-followups {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 10px;
          max-width: 100%;
        }
        .cfo-followup-chip {
          text-align: left;
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 10px 14px;
          border-radius: 999px;
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1.35;
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s, color 0.12s,
            transform 0.06s;
          font-family: var(--font-sans), sans-serif;
        }
        .cfo-followup-chip:hover:not(:disabled) {
          background: var(--accent-bg);
          border-color: var(--accent-dim);
          color: var(--accent);
        }
        .cfo-followup-chip:active:not(:disabled) {
          transform: scale(0.98);
        }
        .cfo-followup-chip:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        /* ─── Typing dots ───────────────────────────────────────── */
        .cfo-typing-bubble {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 12px 16px;
        }
        .cfo-typing-dot {
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--muted-strong);
          opacity: 0.4;
          animation: cfoTypingBounce 1.2s infinite ease-in-out;
        }
        .cfo-typing-dot:nth-child(2) {
          animation-delay: 0.2s;
        }
        .cfo-typing-dot:nth-child(3) {
          animation-delay: 0.4s;
        }
        @keyframes cfoTypingBounce {
          0%,
          60%,
          100% {
            opacity: 0.35;
            transform: translateY(0);
          }
          30% {
            opacity: 1;
            transform: translateY(-3px);
          }
        }
        .cfo-error {
          color: var(--negative);
          background: var(--negative-bg);
          padding: 10px 14px;
          border-radius: 12px;
          font-size: 12.5px;
          border: 1px solid var(--negative);
        }

        /* ─── Markdown content ──────────────────────────────────── */
        .cfo-md > :first-child {
          margin-top: 0;
        }
        .cfo-md > :last-child {
          margin-bottom: 0;
        }
        .cfo-md p {
          margin: 0 0 10px;
        }
        .cfo-md strong {
          font-weight: 700;
          color: var(--text);
        }
        .cfo-md em {
          font-style: italic;
          color: var(--text-dim);
        }
        .cfo-md ul,
        .cfo-md ol {
          margin: 8px 0;
          padding-left: 20px;
        }
        .cfo-md li {
          margin: 3px 0;
        }
        .cfo-md code {
          font-family: var(--font-mono), monospace;
          font-size: 12px;
          background: var(--surface-3);
          padding: 1px 5px;
          border-radius: 4px;
          color: var(--accent);
        }
        .cfo-md pre {
          background: var(--surface-inset);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 10px 12px;
          overflow-x: auto;
          margin: 8px 0;
        }
        .cfo-md pre code {
          background: transparent;
          padding: 0;
          color: var(--text);
        }
        .cfo-md table {
          border-collapse: collapse;
          margin: 10px 0;
          font-size: 12.5px;
          width: 100%;
        }
        .cfo-md th,
        .cfo-md td {
          border: 1px solid var(--border);
          padding: 6px 10px;
          text-align: left;
        }
        .cfo-md th {
          background: var(--surface-3);
          font-weight: 600;
        }
        .cfo-md a {
          color: var(--accent);
          text-decoration: underline;
        }
        .cfo-md blockquote {
          border-left: 3px solid var(--accent);
          padding-left: 12px;
          margin: 8px 0;
          color: var(--text-dim);
        }

        /* ─── Input area ────────────────────────────────────────── */
        .cfo-input-wrap {
          flex-shrink: 0;
          padding: 12px 16px 14px;
          border-top: 1px solid var(--border);
          background: var(--surface);
        }
        .cfo-input-row {
          display: flex;
          gap: 10px;
          align-items: flex-end;
        }
        .cfo-input-row textarea {
          flex: 1;
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 11px 18px;
          border-radius: 22px;
          font-size: 14px;
          font-family: var(--font-sans), sans-serif;
          resize: none;
          min-height: 44px;
          max-height: 140px;
          line-height: 1.45;
          overflow-y: auto;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
          transition: border-color 0.15s, box-shadow 0.15s;
          /* Strip browser chrome (number-spinner arrows, default outlines,
             extra inner padding) so the field is a clean pill on every OS. */
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: textfield;
        }
        .cfo-input-row textarea::-webkit-scrollbar {
          width: 6px;
        }
        .cfo-input-row textarea::-webkit-scrollbar-thumb {
          background: var(--border-strong);
          border-radius: 6px;
        }
        .cfo-input-row textarea::-webkit-inner-spin-button,
        .cfo-input-row textarea::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .cfo-input-row textarea:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-bg);
        }
        .cfo-input-row textarea:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .cfo-input-row textarea::placeholder {
          color: var(--muted);
        }
        .cfo-send-btn {
          background: var(--text);
          color: var(--surface);
          border: none;
          width: 44px;
          height: 44px;
          border-radius: 999px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background 0.12s, transform 0.08s;
          flex-shrink: 0;
        }
        .cfo-send-btn:hover:not(:disabled) {
          background: var(--accent);
          color: var(--on-accent);
        }
        .cfo-send-btn:active:not(:disabled) {
          transform: scale(0.94);
        }
        .cfo-send-btn:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .cfo-disclaimer {
          font-size: 11px;
          color: var(--muted);
          text-align: center;
          margin-top: 8px;
        }

        /* ─── History tab ───────────────────────────────────────── */
        .cfo-history-head {
          text-align: center;
          padding: 8px 0 18px;
        }
        .cfo-history-title-h {
          font-size: 22px;
          font-weight: 700;
          color: var(--text);
          margin: 16px 0 4px;
        }
        .cfo-history-sub {
          font-size: 13px;
          color: var(--text-dim);
          margin: 0;
        }
        .cfo-history-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 4px 12px;
        }
        .cfo-history-count {
          font-size: 13px;
          font-weight: 700;
          color: var(--text);
        }
        .cfo-clear-all {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: transparent;
          border: none;
          color: var(--negative);
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          padding: 4px 6px;
          border-radius: 6px;
          transition: background 0.12s;
          font-family: var(--font-sans), sans-serif;
        }
        .cfo-clear-all:hover:not(:disabled) {
          background: var(--negative-bg);
        }
        .cfo-clear-all:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .cfo-history-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 80px 16px 40px;
          gap: 14px;
        }
        .cfo-history-empty-icon {
          width: 56px;
          height: 56px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--surface-2);
          border-radius: 12px;
          color: var(--muted);
        }
        .cfo-history-empty-text {
          font-size: 13.5px;
          color: var(--muted-strong);
        }
        .cfo-history-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .cfo-history-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 14px 16px;
          border-radius: 14px;
          background: var(--surface-2);
          border: 1px solid var(--border);
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s;
        }
        .cfo-history-row:hover {
          background: var(--surface-3);
          border-color: var(--border-strong);
        }
        .cfo-history-row.active {
          background: var(--accent-bg);
          border-color: var(--accent-dim);
        }
        .cfo-history-row-icon {
          flex-shrink: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--surface-3);
          border-radius: 8px;
          color: var(--text-dim);
        }
        .cfo-history-row.active .cfo-history-row-icon {
          background: var(--accent-bg-strong);
          color: var(--accent);
        }
        .cfo-history-row-body {
          flex: 1;
          min-width: 0;
        }
        .cfo-history-row-title {
          font-size: 13.5px;
          font-weight: 600;
          color: var(--text);
          line-height: 1.35;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cfo-history-row-meta {
          font-size: 11.5px;
          color: var(--muted);
          margin-top: 3px;
        }
        .cfo-history-row-delete {
          flex-shrink: 0;
          background: transparent;
          border: none;
          color: var(--muted);
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          align-self: center;
          transition: background 0.12s, color 0.12s;
        }
        .cfo-history-row-delete:hover {
          background: var(--negative-bg);
          color: var(--negative);
        }

        /* ─── Mobile ────────────────────────────────────────────── */
        @media (max-width: 520px) {
          .cfo-drawer {
            width: 100vw;
          }
        }
      `}</style>
    </>
  );
}

const SUGGESTIONS = [
  "How is revenue this week?",
  "How many active subscribers do we have?",
  "Show me top performing stores",
  "Chargebacks summary this month",
];

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

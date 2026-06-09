// Audit logger for the edit flow.
//
// Every applied edit (i.e. user clicked Confirm and the row was actually
// mutated) writes one row to chat_audit_log. The before_value + after_value
// columns let us:
//   - Show the user "what did I change yesterday?" in a future UI.
//   - Reverse a confirmed edit ("undo my last change").
//   - Cross-check anomalous numbers against deliberate edits.
//
// We DO NOT log:
//   - Pending confirmations that were never confirmed (they live in
//     pending_confirmations until they expire or are cancelled).
//   - The user's natural-language phrasing (it's in chat_messages).
//
// The logger uses the direct pg pool because the rest of the edit flow
// already runs inside a transaction; reusing the same client keeps
// everything atomic.

import type { PoolClient } from "pg";

export type AuditEntry = {
  tenantId: string;
  sessionId: string;
  messageId?: string | null;
  userId: string | null;
  toolName: string;
  targetTable: string;
  targetPk: Record<string, unknown>;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown>;
};

export async function writeAuditEntry(
  client: PoolClient,
  entry: AuditEntry,
): Promise<string> {
  const sql = `
    INSERT INTO chat_audit_log
      (tenant_id, session_id, message_id, user_id,
       tool_name, target_table, target_pk,
       before_value, after_value, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, 'applied')
    RETURNING id
  `;
  const { rows } = await client.query<{ id: string }>(sql, [
    entry.tenantId,
    entry.sessionId,
    entry.messageId ?? null,
    entry.userId,
    entry.toolName,
    entry.targetTable,
    JSON.stringify(entry.targetPk),
    entry.beforeValue ? JSON.stringify(entry.beforeValue) : null,
    JSON.stringify(entry.afterValue),
  ]);
  return rows[0].id;
}

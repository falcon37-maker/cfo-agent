// Shared infra for edit categories — single place that creates pending
// confirmation rows so we can enforce per-user limits + audit invariants
// in one spot.

import type { PoolClient } from "pg";
import { MAX_PENDING_PER_USER } from "../whitelist";

export async function createPending(
  client: PoolClient,
  args: {
    tenantId: string;
    sessionId: string;
    messageId: string | null;
    userId: string;
    toolName: string;
    targetTable: string;
    targetPk: Record<string, unknown>;
    beforeValue: Record<string, unknown> | null;
    afterValue: Record<string, unknown>;
    humanSummary: string;
  },
): Promise<string> {
  // Enforce per-user pending limit. A burst of edits without confirmation
  // is the signature of a runaway model — we stop the pile-up here so
  // the user isn't surprised by a backlog of pending cards.
  const { rows: cntRows } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM pending_confirmations
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'pending'`,
    [args.tenantId, args.userId],
  );
  const currentPending = Number(cntRows[0]?.n ?? 0);
  if (currentPending >= MAX_PENDING_PER_USER) {
    throw new Error(
      `You already have ${currentPending} edits waiting for confirmation. Resolve those first.`,
    );
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO pending_confirmations
       (tenant_id, session_id, message_id, user_id,
        tool_name, target_table, target_pk,
        before_value, after_value, human_summary)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7::jsonb, $8::jsonb, $9::jsonb, $10)
     RETURNING id`,
    [
      args.tenantId,
      args.sessionId,
      args.messageId,
      args.userId,
      args.toolName,
      args.targetTable,
      JSON.stringify(args.targetPk),
      args.beforeValue ? JSON.stringify(args.beforeValue) : null,
      JSON.stringify(args.afterValue),
      args.humanSummary,
    ],
  );
  return rows[0].id;
}

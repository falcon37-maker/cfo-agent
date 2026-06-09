// "cogs_edit" — change a daily COGS total for one store.
//
// Editable target: cogs_entries (cogs per store-day).
// All validation goes through the central whitelist.

import { z } from "zod";
import { withClient } from "@/lib/db/direct";
import type { EditCategoryModule, EditBuildResult } from "../_base";
import { createPending } from "./_shared";
import {
  validateAmount,
  validateDate,
  validateStoreId,
  validateReason,
} from "../whitelist";

const PARAMS = z.object({
  store_id: z.string().min(1).max(32),
  date: z.string().min(1).max(32),
  new_amount: z.union([z.number(), z.string()]),
  reason: z.string().max(280).optional(),
});

export const cogsEditCategory: EditCategoryModule = {
  id: "cogs_edit",
  name: "COGS Edit",

  description:
    "Update the COGS amount for a specific store on a specific date. Use this when the user wants to correct a logged COGS value.",

  examples: [
    "change NOVA COGS on May 1 to $1200",
    "fix NURA cogs for April 15 — should be 800",
    "set COGS for KOVA 2026-04-10 to $0",
  ],

  prompt: `# Mode: COGS Edit

The user wants to correct a COGS entry. Call the update_cogs tool with:
  - store_id: the store code EXACTLY as the user wrote it, in UPPERCASE. Pass through anything matching letters/digits/underscores. The server checks whether the store actually belongs to the user's workspace. DO NOT reject store codes yourself.
  - date: YYYY-MM-DD
  - new_amount: dollar amount (plain number, no $ or commas)
  - reason: one short sentence (optional)

Rules:
  - You may ONLY call the tool when the user explicitly mentioned "COGS" (or "cost of goods"). If the user only said something like "add 20k NOVA" without naming the field, do NOT call the tool — ask "Is that ad spend, COGS, or revenue?" instead.
  - If date or amount is missing or ambiguous, ASK.
  - new_amount must be 0 or higher and below $10,000,000.
  - One edit per turn.
  - Don't reject store codes yourself — always call the tool and let the server validate.

After the tool runs the UI renders a confirm card. Your reply: ONE short sentence pointing at it ("Ready to review below."). Never restate the store, date, amount, or "click Confirm/Cancel".`,

  tools: [
    {
      id: "update_cogs",
      description:
        "Stage a COGS update awaiting user confirmation. Looks up current value, creates a pending_confirmations row.",
      params_schema: PARAMS,
      build: async (rawIn, ctx): Promise<EditBuildResult> => {
        let storeId: string;
        let date: string;
        let amount: number;
        let reason: string | null;
        try {
          const parsed = PARAMS.parse(rawIn);
          storeId = validateStoreId(parsed.store_id);
          date = validateDate(parsed.date);
          amount = validateAmount(parsed.new_amount, "COGS");
          reason = validateReason(parsed.reason);
        } catch (e) {
          return {
            kind: "error",
            message: (e as Error).message,
          };
        }

        return await withClient(async (client) => {
          // Verify the store exists for this tenant — see ad_spend_edit
          // for the rationale.
          const storeRes = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(
                SELECT 1 FROM stores
                WHERE tenant_id = $1 AND id = $2
              ) AS exists`,
            [ctx.tenantId, storeId],
          );
          if (!storeRes.rows[0]?.exists) {
            return {
              kind: "error",
              message: `Your workspace doesn't have a store called "${storeId}". I can edit COGS only for stores attached to your account.`,
            };
          }

          const currentRes = await client.query<{
            total: string | number;
            count: number;
          }>(
            `SELECT COALESCE(SUM(cogs), 0)::numeric AS total, COUNT(*)::int AS count
             FROM cogs_entries
             WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
            [ctx.tenantId, storeId, date],
          );
          const currentTotal = Number(currentRes.rows[0]?.total ?? 0);
          const currentCount = Number(currentRes.rows[0]?.count ?? 0);

          if (Math.abs(currentTotal - amount) < 0.005) {
            return {
              kind: "noop",
              message: `COGS for ${storeId} on ${date} is already $${fmt(amount)}. Nothing to change.`,
            };
          }

          const summary = `${storeId} COGS on ${date}: $${fmt(currentTotal)} → $${fmt(amount)}`;

          const pendingId = await createPending(client, {
            tenantId: ctx.tenantId,
            sessionId: ctx.sessionId,
            messageId: ctx.messageId ?? null,
            userId: ctx.userId,
            toolName: "update_cogs",
            targetTable: "cogs_entries",
            targetPk: { store_id: storeId, date },
            beforeValue: {
              total_amount: currentTotal,
              entry_count: currentCount,
            },
            afterValue: {
              total_amount: amount,
              reason,
            },
            humanSummary: summary,
          });

          return {
            kind: "needs_confirmation",
            pending_id: pendingId,
            tool_name: "update_cogs",
            target_table: "cogs_entries",
            target_pk: { store_id: storeId, date },
            before_value: {
              total_amount: currentTotal,
              entry_count: currentCount,
            },
            after_value: {
              total_amount: amount,
              reason,
            },
            human_summary: summary,
          };
        });
      },
    },
  ],
};

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

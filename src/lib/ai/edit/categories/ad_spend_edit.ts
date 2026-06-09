// "ad_spend_edit" — change a daily ad_spend total for one store.
//
// Editable target: ad_spend_entries (amount per store-day).
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

// Loose Zod schema — the heavy validation runs through the whitelist
// helpers below. We accept loose types here so the model can be slightly
// imprecise (e.g. lowercase store id) and we normalize/reject server-side.
const PARAMS = z.object({
  store_id: z.string().min(1).max(32),
  date: z.string().min(1).max(32),
  new_amount: z.union([z.number(), z.string()]),
  reason: z.string().max(280).optional(),
});

export const adSpendEditCategory: EditCategoryModule = {
  id: "ad_spend_edit",
  name: "Ad Spend Edit",

  description:
    "Update the ad spend amount for a specific store on a specific date. Use this when the user wants to correct a logged ad-spend value.",

  examples: [
    "change NOVA ad spend on May 1 to $2000",
    "fix April 10 NURA ads — should be 1500",
    "set ad spend for KOVA 2026-04-15 to $0",
    "the ad spend for NOVA yesterday is wrong, it was 800",
  ],

  prompt: `# Mode: Ad Spend Edit

The user wants to correct an ad spend entry. Call the update_ad_spend tool with:
  - store_id: the store code EXACTLY as the user wrote it, in UPPERCASE. Whatever they say — "NOVA", "NOVA_TEST", "ELARA_2", anything matching letters/digits/underscores — pass it through. The server checks whether that store actually belongs to the user's workspace and will return an error if not. DO NOT make up a list of "valid" stores and reject the user's input yourself.
  - date: YYYY-MM-DD
  - new_amount: dollar amount as a plain number (no $, no commas)
  - reason: one short sentence explaining the correction (optional but recommended)

Rules:
  - You may ONLY call the tool when the user explicitly mentioned "ad spend" (or a clear synonym like "ads", "ad cost"). If the user only said something like "add 20k NOVA" without naming the field, do NOT call the tool — ask "Is that ad spend, COGS, or revenue?" instead.
  - If the date or amount is missing or ambiguous, ASK — don't guess.
  - new_amount must be 0 or higher and below $10,000,000.
  - Don't propose multiple edits in one turn — one at a time.
  - Don't reject store codes yourself. Always call the tool; the server is the source of truth on which stores exist.

After the tool runs, the UI renders a confirmation card with all the details and Confirm/Cancel buttons. Your reply must be ONE short sentence pointing at the card ("Ready to review below.", "Take a look."). Never repeat the store, date, amount, or "click Confirm/Cancel" — the card already shows that.`,

  tools: [
    {
      id: "update_ad_spend",
      description:
        "Stage an ad spend update awaiting user confirmation. Looks up the current value, creates a pending_confirmations row, returns a summary the chat UI renders as a confirm card.",
      params_schema: PARAMS,
      build: async (rawIn, ctx): Promise<EditBuildResult> => {
        // ── Whitelist validation (throws with user-safe error) ─────────
        let storeId: string;
        let date: string;
        let amount: number;
        let reason: string | null;
        try {
          const parsed = PARAMS.parse(rawIn);
          storeId = validateStoreId(parsed.store_id);
          date = validateDate(parsed.date);
          amount = validateAmount(parsed.new_amount, "ad spend");
          reason = validateReason(parsed.reason);
        } catch (e) {
          return {
            kind: "error",
            message: (e as Error).message,
          };
        }

        return await withClient(async (client) => {
          // Verify the store exists for this tenant — otherwise the
          // confirm-step INSERT will fail with a foreign-key violation
          // and the user won't understand why. Fail fast here with a
          // friendly message instead.
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
              message: `Your workspace doesn't have a store called "${storeId}". I can edit ad spend only for stores attached to your account.`,
            };
          }

          // Statement timeout already set at pool level. Look up current
          // total — parameterized, tenant-scoped.
          const currentRes = await client.query<{
            total: string | number;
            count: number;
          }>(
            `SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count
             FROM ad_spend_entries
             WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
            [ctx.tenantId, storeId, date],
          );
          const currentTotal = Number(currentRes.rows[0]?.total ?? 0);
          const currentCount = Number(currentRes.rows[0]?.count ?? 0);

          if (Math.abs(currentTotal - amount) < 0.005) {
            return {
              kind: "noop",
              message: `Ad spend for ${storeId} on ${date} is already $${fmt(amount)}. Nothing to change.`,
            };
          }

          const summary = `${storeId} ad spend on ${date}: $${fmt(currentTotal)} → $${fmt(amount)}`;

          const pendingId = await createPending(client, {
            tenantId: ctx.tenantId,
            sessionId: ctx.sessionId,
            messageId: ctx.messageId ?? null,
            userId: ctx.userId,
            toolName: "update_ad_spend",
            targetTable: "ad_spend_entries",
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
            tool_name: "update_ad_spend",
            target_table: "ad_spend_entries",
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

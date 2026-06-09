// "revenue_edit" — change a manual revenue entry amount.
//
// Editable target: manual_revenue_entries (amount per store-day-type).
// Shopify and PHX revenue come from upstream APIs and are NOT user-editable.

import { z } from "zod";
import { withClient } from "@/lib/db/direct";
import type { EditCategoryModule, EditBuildResult } from "../_base";
import { createPending } from "./_shared";
import {
  validateAmount,
  validateDate,
  validateStoreId,
  validateReason,
  validateRevenueType,
} from "../whitelist";

const PARAMS = z.object({
  store_id: z.string().min(1).max(32).optional(),
  date: z.string().min(1).max(32),
  revenue_type: z.string().min(1).max(64),
  new_amount: z.union([z.number(), z.string()]),
  reason: z.string().max(280).optional(),
});

export const revenueEditCategory: EditCategoryModule = {
  id: "revenue_edit",
  name: "Manual Revenue Edit",

  description:
    "Update a manual revenue entry (coaching, consulting, one-off sales — anything not from Shopify or Solvpath). Cannot modify Shopify or PHX numbers.",

  examples: [
    "change coaching revenue on April 15 to $5000",
    "set consulting income for 2026-05-01 to $1200",
    "fix the coaching entry — should be 750",
  ],

  prompt: `# Mode: Manual Revenue Edit

The user wants to change a MANUAL revenue entry — Shopify and subscription numbers can't be edited (they sync from upstream APIs).

Call the update_manual_revenue tool with:
  - store_id: OPTIONAL — set only if the user explicitly named a store. Pass it through as the user wrote it (UPPERCASE letters/digits/underscore); the server checks ownership.
  - date: YYYY-MM-DD
  - revenue_type: short label like "coaching", "consulting", "one-off"
  - new_amount: dollar amount (plain number)
  - reason: one short sentence (optional)

Rules:
  - BEFORE calling the tool you MUST have: (1) a clear revenue_type the user named (e.g. "coaching", "consulting"), (2) a date, (3) an amount. Missing ANY of these → ASK, don't guess.
  - If the user only said something like "add 20k NOVA" with no revenue type, do NOT call the tool — ask "Is that ad spend, COGS, or a manual revenue entry like coaching?" instead.
  - If the user is vague about which manual entry to change, ASK.
  - If they ask to change Shopify or PHX revenue, politely explain those come from API sync and aren't editable here.
  - new_amount must be 0 or higher and below $10,000,000.
  - Don't reject store codes yourself — always call the tool and let the server validate.

After the tool runs the UI renders a confirm card. Your reply: ONE short sentence pointing at it ("Ready to review below."). Never restate the store, date, amount, or "click Confirm/Cancel".`,

  tools: [
    {
      id: "update_manual_revenue",
      description:
        "Stage a manual_revenue_entries update awaiting user confirmation.",
      params_schema: PARAMS,
      build: async (rawIn, ctx): Promise<EditBuildResult> => {
        let storeId: string | null;
        let date: string;
        let revenueType: string;
        let amount: number;
        let reason: string | null;
        try {
          const parsed = PARAMS.parse(rawIn);
          storeId = parsed.store_id ? validateStoreId(parsed.store_id) : null;
          date = validateDate(parsed.date);
          revenueType = validateRevenueType(parsed.revenue_type);
          amount = validateAmount(parsed.new_amount, "revenue amount");
          reason = validateReason(parsed.reason);
        } catch (e) {
          return {
            kind: "error",
            message: (e as Error).message,
          };
        }

        return await withClient(async (client) => {
          // If a store was named, verify it belongs to this tenant.
          if (storeId) {
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
                message: `Your workspace doesn't have a store called "${storeId}". I can attach manual revenue only to stores in your account, or leave the store blank.`,
              };
            }
          }

          const args: unknown[] = [ctx.tenantId, date, revenueType];
          let whereStore = "store_id IS NULL";
          if (storeId) {
            args.push(storeId);
            whereStore = `store_id = $${args.length}`;
          }
          const currentRes = await client.query<{
            total: string | number;
            count: number;
          }>(
            `SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count
             FROM manual_revenue_entries
             WHERE tenant_id = $1
               AND date = $2
               AND revenue_type = $3
               AND ${whereStore}`,
            args,
          );
          const currentTotal = Number(currentRes.rows[0]?.total ?? 0);
          const currentCount = Number(currentRes.rows[0]?.count ?? 0);

          if (Math.abs(currentTotal - amount) < 0.005) {
            return {
              kind: "noop",
              message: `Manual revenue (${revenueType}) on ${date} is already $${fmt(amount)}.`,
            };
          }

          const storeLabel = storeId ? ` for ${storeId}` : "";
          const summary = `Manual revenue (${revenueType})${storeLabel} on ${date}: $${fmt(currentTotal)} → $${fmt(amount)}`;

          const pendingId = await createPending(client, {
            tenantId: ctx.tenantId,
            sessionId: ctx.sessionId,
            messageId: ctx.messageId ?? null,
            userId: ctx.userId,
            toolName: "update_manual_revenue",
            targetTable: "manual_revenue_entries",
            targetPk: {
              store_id: storeId,
              date,
              revenue_type: revenueType,
            },
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
            tool_name: "update_manual_revenue",
            target_table: "manual_revenue_entries",
            target_pk: {
              store_id: storeId,
              date,
              revenue_type: revenueType,
            },
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

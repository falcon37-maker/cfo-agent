// Push a confirmed categorization back to Zoho Books — i.e. actually categorize
// the uncategorized bank transaction there. The right endpoint/payload depends
// on the TARGET account's type (expense / income / bank-transfer / equity).
//
// Zoho direction convention: debit = money IN (deposit), credit = money OUT.

import { zohoFetch } from "./client";

const EXPENSE_TYPES = new Set([
  "expense",
  "cost_of_goods_sold",
  "other_expense",
]);

export type ZohoCategorizeInput = {
  transactionId: string; // Zoho bank transaction id (= our transaction_id)
  bankAccountId: string; // the bank account the transaction sits in
  targetAccountId: string; // the chart-of-accounts account we're categorizing into
  targetAccountType: string; // income | expense | bank | credit_card | equity | …
  amount: number;
  date: string; // YYYY-MM-DD
  description?: string;
  debitOrCredit: string; // "debit" = money IN, "credit" = money OUT
};

async function post(
  tenantId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await zohoFetch<{ code: number; message: string }>(
    tenantId,
    path,
    { method: "POST", body },
  );
  if (res.code !== 0) {
    throw new Error(`Zoho categorize failed: ${res.message}`);
  }
}

export async function categorizeInZoho(
  tenantId: string,
  t: ZohoCategorizeInput,
): Promise<void> {
  const base = `/banktransactions/uncategorized/${t.transactionId}/categorize`;
  const isIn = t.debitOrCredit === "debit"; // money IN
  const common = {
    amount: t.amount,
    date: t.date,
    description: t.description ?? "",
  };

  // ── Expense / COGS (money out into a P&L expense account) ──
  if (EXPENSE_TYPES.has(t.targetAccountType)) {
    await post(tenantId, `${base}/expenses`, {
      account_id: t.targetAccountId,
      paid_through_account_id: t.bankAccountId,
      ...common,
    });
    return;
  }

  // ── Income (money in → revenue account) ──
  if (t.targetAccountType === "income") {
    await post(tenantId, base, {
      transaction_type: "sales_without_invoices",
      to_account_id: t.bankAccountId, // deposit lands in the bank
      from_account_id: t.targetAccountId, // revenue account
      ...common,
    });
    return;
  }

  // ── Internal transfer between the company's own accounts ──
  if (t.targetAccountType === "bank" || t.targetAccountType === "credit_card") {
    if (t.targetAccountId === t.bankAccountId) {
      throw new Error(
        "Transfer target is the same account — a self-transfer can't be recorded. Re-categorize this to the OTHER account.",
      );
    }
    await post(tenantId, base, {
      transaction_type: "transfer_fund",
      from_account_id: isIn ? t.targetAccountId : t.bankAccountId,
      to_account_id: isIn ? t.bankAccountId : t.targetAccountId,
      ...common,
    });
    return;
  }

  // ── Owner equity: contribution (in) / drawings (out) ──
  if (t.targetAccountType === "equity") {
    if (isIn) {
      await post(tenantId, base, {
        transaction_type: "owner_contribution",
        to_account_id: t.bankAccountId,
        from_account_id: t.targetAccountId,
        ...common,
      });
    } else {
      await post(tenantId, base, {
        transaction_type: "owner_drawings",
        from_account_id: t.bankAccountId,
        to_account_id: t.targetAccountId,
        ...common,
      });
    }
    return;
  }

  // ── Fallback (other asset/liability accounts): route by direction ──
  if (isIn) {
    await post(tenantId, base, {
      transaction_type: "sales_without_invoices",
      to_account_id: t.bankAccountId,
      from_account_id: t.targetAccountId,
      ...common,
    });
  } else {
    await post(tenantId, `${base}/expenses`, {
      account_id: t.targetAccountId,
      paid_through_account_id: t.bankAccountId,
      ...common,
    });
  }
}

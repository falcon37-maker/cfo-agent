// Zoho Books banking helpers for the AI labeling flow. Thin wrappers over
// zohoFetch that normalize the bits the classifier + review UI need.
//
// Uncategorized transactions live PER bank account in Zoho — the flat
// /banktransactions endpoint 400s for status=uncategorized ("account does not
// exist"). So we list bank accounts, then page each account that has a
// non-zero uncategorized count.

import { zohoFetch } from "./client";

export type ZohoBankAccount = {
  account_id: string;
  account_name: string;
  account_number?: string; // masked, e.g. "xxxx0817"
  uncategorized_transactions: number;
};

export type UncategorizedTxn = {
  transaction_id: string;
  account_id: string;
  account_name: string;
  date: string; // YYYY-MM-DD
  amount: number;
  debit_or_credit: string; // "debit" | "credit"
  payee: string;
  description: string;
};

export type ChartAccount = {
  account_id: string;
  account_name: string;
  account_type: string; // income | expense | cost_of_goods_sold | ...
};

const PER_PAGE = 200;
const MAX_PAGES_PER_ACCOUNT = 25; // safety cap (≤ 5000 txns/account)

/** Optional date window (YYYY-MM-DD) + overall result cap. */
export type FetchOpts = { from?: string; to?: string; limit?: number };

/** All bank accounts with their pending uncategorized counts. */
export async function listBankAccounts(
  tenantId: string,
): Promise<ZohoBankAccount[]> {
  const data = await zohoFetch<{ bankaccounts?: ZohoBankAccount[] }>(
    tenantId,
    "/bankaccounts",
  );
  return data.bankaccounts ?? [];
}

/** Chart of accounts — the category list the AI labels into. */
export async function listChartAccounts(
  tenantId: string,
): Promise<ChartAccount[]> {
  const data = await zohoFetch<{ chartofaccounts?: ChartAccount[] }>(
    tenantId,
    "/chartofaccounts",
  );
  return (data.chartofaccounts ?? []).map((a) => ({
    account_id: a.account_id,
    account_name: a.account_name,
    account_type: a.account_type,
  }));
}

type RawTxn = {
  transaction_id: string;
  date?: string;
  amount?: number;
  debit_or_credit?: string;
  payee?: string;
  description?: string;
};

async function listUncategorizedForAccount(
  tenantId: string,
  account: ZohoBankAccount,
  opts: FetchOpts = {},
): Promise<UncategorizedTxn[]> {
  const out: UncategorizedTxn[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_ACCOUNT; page++) {
    const data = await zohoFetch<{
      banktransactions?: RawTxn[];
      page_context?: { has_more_page?: boolean };
    }>(tenantId, `/bankaccounts/${account.account_id}/transactions`, {
      query: { status: "uncategorized", per_page: PER_PAGE, page },
    });
    const rows = data.banktransactions ?? [];
    for (const r of rows) {
      const d = r.date ?? "";
      // Zoho's banking endpoint ignores from_date/to_date for uncategorized
      // transactions, so we apply the selected date window ourselves.
      if (opts.from && d < opts.from) continue;
      if (opts.to && d > opts.to) continue;
      out.push({
        transaction_id: r.transaction_id,
        account_id: account.account_id,
        account_name: account.account_name,
        date: d,
        amount: Number(r.amount ?? 0),
        debit_or_credit: r.debit_or_credit ?? "",
        payee: r.payee ?? "",
        description: r.description ?? "",
      });
    }
    if (!data.page_context?.has_more_page) break;
  }
  return out;
}

/** Every uncategorized transaction across all bank accounts, optionally within
 *  a date window. Pass `limit` to cap how many are returned. */
export async function listUncategorizedTransactions(
  tenantId: string,
  opts: FetchOpts = {},
): Promise<UncategorizedTxn[]> {
  const accounts = await listBankAccounts(tenantId);
  // When a date window is set, an account's lifetime uncategorized count tells
  // us nothing about that window — so don't pre-skip on it.
  const withWork = opts.from || opts.to
    ? accounts
    : accounts.filter((a) => (a.uncategorized_transactions ?? 0) > 0);
  const all: UncategorizedTxn[] = [];
  for (const acc of withWork) {
    const rows = await listUncategorizedForAccount(tenantId, acc, opts);
    all.push(...rows);
    if (opts.limit && all.length >= opts.limit) return all.slice(0, opts.limit);
  }
  return all;
}

/** Write a category back to Zoho: assign an uncategorized bank transaction to
 *  a chart-of-accounts category. Mirrors /api/zoho/transactions/categorize. */
export async function categorizeTransaction(
  tenantId: string,
  transactionId: string,
  categoryAccountId: string,
): Promise<void> {
  await zohoFetch<unknown>(
    tenantId,
    `/banktransactions/uncategorized/${encodeURIComponent(transactionId)}/categorize`,
    { method: "POST", body: { from_account_id: categoryAccountId } },
  );
}

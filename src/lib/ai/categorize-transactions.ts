// AI bookkeeping classifier: maps each uncategorized Zoho bank transaction to
// a chart-of-accounts category. Returns a suggestion + confidence; nothing is
// written to Zoho here (that happens on human confirm). Uses a forced tool
// call so the model returns strict JSON we can trust.

import { anthropicClient, anthropicModel } from "./client";
import type { ChartAccount, UncategorizedTxn } from "@/lib/zoho/transactions";

export type Classification = {
  transaction_id: string;
  suggested_account_id: string | null;
  suggested_category_name: string | null;
  confidence: number; // 0..1
  reasoning: string;
};

const BATCH_SIZE = 30;
const MAX_TOKENS = 8000;

const SYSTEM = [
  "You are an expert CPA, Chartered Accountant and bookkeeper for an e-commerce business. Categorize each bank transaction into EXACTLY ONE chart-of-accounts account, identified by its account_id from the provided list. Follow GAAP. Never guess from the merchant name alone.",
  "",
  "DIRECTION CONVENTION (Zoho bank feed): debit_or_credit='debit' is a DEPOSIT — money IN to the bank (revenue / settlement / transfer-in). 'credit' is a WITHDRAWAL — money OUT of the bank (expense / fee / transfer-out).",
  "",
  "Decide using THIS PRIORITY ORDER — transaction direction is the STRONGEST signal:",
  "1. DIRECTION (deposit vs withdrawal). NEVER classify a DEPOSIT (debit) as an expense, and NEVER classify a WITHDRAWAL (credit) as income, unless evidence is overwhelming. A large positive deposit can NEVER be a bank fee.",
  "2. TRANSFER DETECTION: money moving between the company's OWN accounts (Mercury Checking / Mercury Credit / Mercury Savings / USD account / PLAT / B ACCOUNT, or descriptions like 'IO PAYMENT', 'Transfer') → categorize to the OTHER account named in the description/merchant, NOT income or expense. IMPORTANT: the target must be DIFFERENT from the bank_account the transaction is already in — e.g. an 'IO PAYMENT; Merchant name: Mercury Checking' sitting in the Mercury Credit account must go to 'Mercury Checking' (never back to Mercury Credit). Never pick the same account (no self-transfer).",
  "3. MERCHANT & PROCESSOR: payment processors (PAYARC, EMS, Stripe, Square, Shopify, GATEWAY SERVICES) settle BOTH deposits and fees — never assume they are always an expense.",
  "4. DESCRIPTION KEYWORDS.",
  "",
  "DEPOSITS (debit / money IN): descriptions with DEP, CR CD DEP, BKRD DEP, BATCH DEP, SETTLEMENT, WEBPAYMENT, RES REL, or from a processor (PAYARC/EMS/GATEWAY SERVICES/Shopify/Stripe) are customer settlements → an INCOME account (usually 'Sales'; bank/card cashback → 'Interest Income').",
  "",
  "WITHDRAWALS (credit / money OUT): use the merchant to pick the expense account — Facebook/Meta/Google/TikTok ads → Advertising And Marketing; Upwork/Fiverr/freelancers → Consultant Expense; payroll to individuals → Salaries and Employee Wages; AWS/OpenAI/Namecheap/Vercel/Zoho/hosting/domains → IT and Internet Expenses; overseas suppliers / inventory (e.g. HK Mushang, WE Longterm) → Cost of Goods Sold; airlines/hotels → Travel Expense; office rent → Rent Expense.",
  "",
  "CHARGEBACKS: description with CHBK or 'chargeback' AND a WITHDRAWAL (credit) → 'Bad Debt' (a loss, NEVER Sales). CHBK AND a DEPOSIT (debit) → income (chargeback reversal / recovered sale).",
  "",
  "BANK FEES: choose 'Bank Fees and Charges' ONLY when the description clearly indicates a fee (Fee, Monthly Fee, Service Charge, Wire Fee, NSF, Overdraft, Processing Fee) AND it is a withdrawal. NEVER put a deposit in Bank Fees.",
  "",
  "OWNER / EQUITY: incoming funding from the owner's own entity → 'Owner's Equity'; owner withdrawals → 'Drawings'.",
  "",
  "Only choose an account_id that appears in the provided list. Never invent one. confidence: 1 = certain; below 0.6 means it needs manual review. Keep reasoning to one short clause citing the DIRECTION + evidence.",
].join("\n");

const TOOL = {
  name: "record_classifications",
  description: "Record the category for each transaction.",
  input_schema: {
    type: "object" as const,
    properties: {
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            transaction_id: { type: "string" },
            category_account_id: {
              type: "string",
              description: "account_id taken from the provided category list",
            },
            confidence: { type: "number" },
            reasoning: { type: "string" },
          },
          required: [
            "transaction_id",
            "category_account_id",
            "confidence",
            "reasoning",
          ],
        },
      },
    },
    required: ["classifications"],
  },
};

type RawClassification = {
  transaction_id: string;
  category_account_id: string;
  confidence: number;
  reasoning: string;
};

async function classifyBatch(
  batch: UncategorizedTxn[],
  categories: ChartAccount[],
  byId: Map<string, ChartAccount>,
): Promise<Classification[]> {
  const client = anthropicClient();

  const categoryList = categories
    .map((c) => `- ${c.account_id} | ${c.account_name} (${c.account_type})`)
    .join("\n");
  const txnList = batch.map((t) => ({
    transaction_id: t.transaction_id,
    date: t.date,
    amount: t.amount,
    debit_or_credit: t.debit_or_credit,
    // Explicit, unambiguous direction derived from the Zoho convention.
    direction:
      t.debit_or_credit === "debit"
        ? "DEPOSIT (money IN)"
        : "WITHDRAWAL (money OUT)",
    bank_account: t.account_name,
    payee: t.payee,
    description: t.description,
  }));

  const res = await client.messages.create({
    model: anthropicModel(),
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "record_classifications" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `CATEGORIES (account_id | name (type)):\n${categoryList}\n\n` +
              `TRANSACTIONS (classify every one):\n${JSON.stringify(txnList, null, 2)}`,
          },
        ],
      },
    ],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  const raw =
    toolUse && "input" in toolUse
      ? ((toolUse.input as { classifications?: RawClassification[] })
          .classifications ?? [])
      : [];

  const byTxn = new Map<string, RawClassification>();
  for (const r of raw) byTxn.set(r.transaction_id, r);

  return batch.map((t) => {
    const r = byTxn.get(t.transaction_id);
    const cat = r ? byId.get(r.category_account_id) : undefined;
    if (!r || !cat) {
      return {
        transaction_id: t.transaction_id,
        suggested_account_id: null,
        suggested_category_name: null,
        confidence: 0,
        reasoning: r ? "AI returned an unknown category" : "No suggestion",
      };
    }
    const conf = Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0;
    return {
      transaction_id: t.transaction_id,
      suggested_account_id: cat.account_id,
      suggested_category_name: cat.account_name,
      confidence: conf,
      reasoning: String(r.reasoning ?? "").slice(0, 280),
    };
  });
}

/** Classify a list of transactions against the chart of accounts. Batches
 *  internally to keep each request small. */
export async function classifyTransactions(
  txns: UncategorizedTxn[],
  categories: ChartAccount[],
): Promise<Classification[]> {
  const byId = new Map(categories.map((c) => [c.account_id, c]));
  const out: Classification[] = [];
  for (let i = 0; i < txns.length; i += BATCH_SIZE) {
    const batch = txns.slice(i, i + BATCH_SIZE);
    out.push(...(await classifyBatch(batch, categories, byId)));
  }
  return out;
}

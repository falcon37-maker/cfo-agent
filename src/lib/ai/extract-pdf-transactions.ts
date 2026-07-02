// Extract transactions from an uploaded bank-statement PDF using Claude's
// native PDF reading. Returns a normalized list the classifier can label —
// same shape the Zoho path produces, so both feed one review queue.

import { anthropicClient, anthropicModel } from "./client";

export type ExtractedTxn = {
  date: string; // YYYY-MM-DD
  amount: number; // positive
  debit_or_credit: "debit" | "credit";
  description: string;
};

const MAX_TOKENS = 16000;

const TOOL = {
  name: "record_transactions",
  description: "Record every transaction line found in the bank statement.",
  input_schema: {
    type: "object" as const,
    properties: {
      transactions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "Transaction date as YYYY-MM-DD" },
            amount: {
              type: "number",
              description: "Positive amount, no currency symbol",
            },
            debit_or_credit: {
              type: "string",
              enum: ["debit", "credit"],
              description: "debit = money out (withdrawal/charge); credit = money in (deposit/payment received)",
            },
            description: { type: "string", description: "Full payee / description text" },
          },
          required: ["date", "amount", "debit_or_credit", "description"],
        },
      },
    },
    required: ["transactions"],
  },
};

/** Send the PDF (base64) to Claude and pull out every transaction row. */
export async function extractPdfTransactions(
  base64Pdf: string,
): Promise<ExtractedTxn[]> {
  const client = anthropicClient();
  const res = await client.messages.create({
    model: anthropicModel(),
    max_tokens: MAX_TOKENS,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "record_transactions" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text:
              "Extract EVERY transaction line from this bank statement. For each row return: " +
              "date (YYYY-MM-DD), amount (positive number, no currency symbol), " +
              "debit_or_credit (debit = money out / withdrawal / charge; credit = money in / " +
              "deposit / payment received), and the full description/payee text. " +
              "Do not skip any rows. Ignore opening/closing balances, running-balance columns, " +
              "and subtotal/summary lines — only real transactions.",
          },
        ],
      },
    ],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  const raw =
    toolUse && "input" in toolUse
      ? ((toolUse.input as { transactions?: ExtractedTxn[] }).transactions ?? [])
      : [];

  return raw
    .map((t) => ({
      date: String(t.date ?? "").slice(0, 10),
      amount: Math.abs(Number(t.amount ?? 0)),
      debit_or_credit: (t.debit_or_credit === "credit" ? "credit" : "debit") as
        | "debit"
        | "credit",
      description: String(t.description ?? "").slice(0, 300),
    }))
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.amount > 0);
}

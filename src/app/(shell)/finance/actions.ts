"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTenant, WRITE_DATA_ROLES } from "@/lib/tenant";
import {
  listUncategorizedTransactions,
  listChartAccounts,
} from "@/lib/zoho/transactions";
import { classifyTransactions } from "@/lib/ai/categorize-transactions";
import { extractPdfTransactions } from "@/lib/ai/extract-pdf-transactions";
import {
  stageSuggestions,
  syncUncategorized,
  listUnlabeled,
  confirmLabel,
  confirmAllSuggested,
  rejectLabel,
  clearPdfLabels,
  cancelPdfPreview,
  confirmPdfPreview,
  getLabelRow,
  markLabelApplied,
} from "@/lib/zoho/labels";
import { categorizeInZoho } from "@/lib/zoho/writeback";
import { createHash } from "node:crypto";

const PAGE = "/finance/transactions";
const FINANCE_PAGE = "/finance"; // PDF statement summary lives on the Overview
// Max transactions to classify per "Run AI labeling" submit. Set high so a
// single run labels everything in one go. A big run (thousands) can take many
// minutes — the modal warns the user. The ceiling is just a runaway backstop.
const RUN_LIMIT = 5000;
// Auto-confirm threshold for the bulk "Confirm all high-confidence" action.
const HIGH_CONF = 0.9;

function enc(s: string): string {
  // Slice the RAW string first, then encode — slicing an already-encoded
  // string can cut a %XX sequence in half and produce a malformed URI.
  return encodeURIComponent(s.slice(0, 200));
}

async function requireWriter() {
  const tenant = await requireTenant();
  if (!WRITE_DATA_ROLES.includes(tenant.role)) {
    redirect(`${PAGE}?lbl_err=forbidden`);
  }
  return tenant;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "Sync & label" for a chosen date window (or all). Pull the window's
 *  uncategorized transactions from Zoho into the DB, then AI-classify every
 *  still-unlabeled row in that window. Chunked so progress persists if a long
 *  run is interrupted (a re-run continues; only new transactions are fetched). */
export async function syncFromZohoAction(formData: FormData): Promise<void> {
  const tenant = await requireWriter();
  const fromIn = String(formData.get("from") ?? "").trim();
  const toIn = String(formData.get("to") ?? "").trim();
  const from = DATE_RE.test(fromIn) ? fromIn : undefined;
  const to = DATE_RE.test(toIn) ? toIn : undefined;
  try {
    // 1. Pull the window's uncategorized transactions from Zoho into the DB.
    const txns = await listUncategorizedTransactions(tenant.id, { from, to });
    await syncUncategorized(tenant.id, txns, "zoho");
    // 2. AI-label every still-unlabeled row in the window (read from the DB).
    const categories = await listChartAccounts(tenant.id);
    const pool = await listUnlabeled(tenant.id, { from, to, limit: RUN_LIMIT });
    let labeled = 0;
    const CHUNK = 300;
    for (let i = 0; i < pool.length; i += CHUNK) {
      const chunk = pool.slice(i, i + CHUNK);
      const cls = await classifyTransactions(chunk, categories);
      labeled += await stageSuggestions(tenant.id, chunk, cls);
    }
    revalidatePath(PAGE);
    redirect(`${PAGE}?synced=${labeled}`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${PAGE}?lbl_err=${enc(msg)}`);
  }
}

/** Upload a bank-statement PDF → AI extracts the transactions, classifies them,
 *  and stages them in the same review queue (source = "pdf"). */
export async function uploadPdfAction(formData: FormData): Promise<void> {
  const tenant = await requireWriter();
  const file = formData.get("pdf");
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${FINANCE_PAGE}?pdf_err=${enc("No PDF selected")}`);
  }
  const f = file as File;
  if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
    redirect(`${FINANCE_PAGE}?pdf_err=${enc("Please upload a PDF file")}`);
  }
  if (f.size > 20 * 1024 * 1024) {
    redirect(`${FINANCE_PAGE}?pdf_err=${enc("PDF too large (max 20MB)")}`);
  }
  try {
    const b64 = Buffer.from(await f.arrayBuffer()).toString("base64");
    const extracted = await extractPdfTransactions(b64);
    if (extracted.length === 0) {
      redirect(`${FINANCE_PAGE}?pdf_labeled=0`);
    }
    const label = f.name.replace(/\.pdf$/i, "").slice(0, 40);
    const txns = extracted.map((e, i) => ({
      // Unique per row within this statement (we replace the prior PDF anyway).
      transaction_id:
        "pdf-" +
        createHash("sha256")
          .update(`${label}|${i}|${e.date}|${e.amount}|${e.debit_or_credit}|${e.description}`)
          .digest("hex")
          .slice(0, 24),
      account_id: "PDF",
      account_name: label,
      date: e.date,
      amount: e.amount,
      debit_or_credit: e.debit_or_credit,
      payee: "",
      description: e.description,
    }));
    // Save as a PREVIEW (not applied). Clear any stale preview first; the
    // currently-applied PDF stays until the user confirms this one.
    await cancelPdfPreview(tenant.id);
    const categories = await listChartAccounts(tenant.id);
    const classifications = await classifyTransactions(
      txns.slice(0, RUN_LIMIT),
      categories,
    );
    const n = await stageSuggestions(
      tenant.id,
      txns.slice(0, RUN_LIMIT),
      classifications,
      "pdf",
      "preview",
    );
    revalidatePath(FINANCE_PAGE);
    redirect(`${FINANCE_PAGE}?pdf_preview=${n}`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${FINANCE_PAGE}?pdf_err=${enc(msg)}`);
  }
}

/** Apply the previewed PDF — its numbers now fill the Overview fields. */
export async function confirmPdfAction(): Promise<void> {
  const tenant = await requireWriter();
  try {
    const n = await confirmPdfPreview(tenant.id);
    revalidatePath(FINANCE_PAGE);
    redirect(`${FINANCE_PAGE}?pdf_applied=${n}`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${FINANCE_PAGE}?pdf_err=${enc(msg)}`);
  }
}

/** Discard the previewed PDF without applying it. */
export async function cancelPdfAction(): Promise<void> {
  const tenant = await requireWriter();
  try {
    await cancelPdfPreview(tenant.id);
    revalidatePath(FINANCE_PAGE);
    redirect(FINANCE_PAGE);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${FINANCE_PAGE}?pdf_err=${enc(msg)}`);
  }
}

/** Remove the uploaded PDF statement — the Overview reverts to Zoho data. */
export async function removePdfAction(): Promise<void> {
  const tenant = await requireWriter();
  try {
    await clearPdfLabels(tenant.id);
    revalidatePath(FINANCE_PAGE);
    redirect(`${FINANCE_PAGE}?pdf_removed=1`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${FINANCE_PAGE}?pdf_err=${enc(msg)}`);
  }
}

/** Bulk-confirm every still-suggested row at/above a chosen confidence (the
 *  form's `min`, 0–1). One fast UPDATE — lets the user clear hundreds at once. */
export async function confirmBulkAction(formData: FormData): Promise<void> {
  const tenant = await requireWriter();
  const raw = Number(formData.get("min"));
  const min = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : HIGH_CONF;
  try {
    const r = await confirmAllSuggested(tenant.id, min);
    revalidatePath(PAGE);
    redirect(`${PAGE}?bulk_confirmed=${r.confirmed}`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${PAGE}?lbl_err=${enc(msg)}`);
  }
}

/** Accept one suggestion → categorize it in Zoho Books, then mark confirmed. */
export async function acceptLabelAction(formData: FormData): Promise<void> {
  const tenant = await requireWriter();
  const txnId = String(formData.get("transaction_id") ?? "").trim();
  if (!txnId) redirect(`${PAGE}?lbl_err=missing_txn`);
  try {
    const row = await getLabelRow(tenant.id, txnId);
    if (!row) redirect(`${PAGE}?lbl_err=${enc("Transaction not found")}`);
    if (!row!.suggested_account_id) {
      redirect(`${PAGE}?lbl_err=${enc("No category assigned to this transaction")}`);
    }
    const coa = await listChartAccounts(tenant.id);
    const acct = coa.find((a) => a.account_id === row!.suggested_account_id);
    if (!acct) {
      redirect(`${PAGE}?lbl_err=${enc("Category not found in Zoho chart of accounts")}`);
    }
    // Push the categorization to Zoho Books.
    await categorizeInZoho(tenant.id, {
      transactionId: txnId,
      bankAccountId: row!.account_id,
      targetAccountId: row!.suggested_account_id!,
      targetAccountType: acct!.account_type,
      amount: Number(row!.amount ?? 0),
      date: row!.txn_date ?? "",
      description: row!.description ?? "",
      debitOrCredit: row!.debit_or_credit ?? "",
    });
    // Only mark applied (in Zoho) once Zoho accepted it.
    await markLabelApplied(tenant.id, txnId);
    revalidatePath(PAGE);
    redirect(`${PAGE}?accepted=1`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${PAGE}?lbl_err=${enc(msg)}`);
  }
}

/** Confirm one suggestion → writes the category back to Zoho. */
export async function confirmLabelAction(formData: FormData): Promise<void> {
  const tenant = await requireWriter();
  const txnId = String(formData.get("transaction_id") ?? "").trim();
  const override = String(formData.get("category_account_id") ?? "").trim();
  if (!txnId) redirect(`${PAGE}?lbl_err=missing_txn`);
  try {
    await confirmLabel(tenant.id, txnId, override || undefined);
    revalidatePath(PAGE);
    redirect(`${PAGE}?confirmed=1`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${PAGE}?lbl_err=${enc(msg)}`);
  }
}

/** Reject one suggestion (leaves it uncategorized in Zoho). */
export async function rejectLabelAction(formData: FormData): Promise<void> {
  const tenant = await requireWriter();
  const txnId = String(formData.get("transaction_id") ?? "").trim();
  if (!txnId) redirect(`${PAGE}?lbl_err=missing_txn`);
  try {
    await rejectLabel(tenant.id, txnId);
    revalidatePath(PAGE);
    redirect(`${PAGE}?rejected=1`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`${PAGE}?lbl_err=${enc(msg)}`);
  }
}

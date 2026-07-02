// Staging store for AI transaction labels (dry-run: stage → confirm → write
// back to Zoho). Backed by the transaction_labels table (migration 024).
// All queries scope by tenant_id via the service-role client.

import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Classification } from "@/lib/ai/categorize-transactions";
import type { UncategorizedTxn } from "@/lib/zoho/transactions";

// NOTE: Confirming records the category in CFO Agent's own ledger
// (transaction_labels). Writing the category back into Zoho Books needs Zoho's
// 2-step reconciliation (create an Expense/Deposit record, then match the bank
// transaction) — that's a separate, future phase, so we don't call Zoho here.

export type LabelRow = {
  transaction_id: string;
  account_id: string;
  account_name: string | null;
  txn_date: string | null;
  amount: number | null;
  debit_or_credit: string | null;
  payee: string | null;
  description: string | null;
  suggested_account_id: string | null;
  suggested_category_name: string | null;
  confidence: number | null;
  reasoning: string | null;
  status: string;
  applied_at: string | null;
};

/** Zoho transaction_ids already staged (any status) — skip re-classifying. */
export async function getStagedTxnIds(tenantId: string): Promise<Set<string>> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("transaction_labels")
    .select("transaction_id")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`getStagedTxnIds: ${error.message}`);
  return new Set((data ?? []).map((r) => r.transaction_id as string));
}

/** Upsert AI suggestions as 'suggested' rows (snapshot of the txn + label). */
export async function stageSuggestions(
  tenantId: string,
  txns: UncategorizedTxn[],
  classifications: Classification[],
  source: "zoho" | "pdf" = "zoho",
  status: string = "suggested",
): Promise<number> {
  if (txns.length === 0) return 0;
  const byTxn = new Map(classifications.map((c) => [c.transaction_id, c]));
  const now = new Date().toISOString();
  const rows = txns.map((t) => {
    const c = byTxn.get(t.transaction_id);
    return {
      transaction_id: t.transaction_id,
      tenant_id: tenantId,
      source,
      account_id: t.account_id,
      account_name: t.account_name,
      txn_date: t.date || null,
      amount: t.amount,
      debit_or_credit: t.debit_or_credit,
      payee: t.payee,
      description: t.description,
      suggested_account_id: c?.suggested_account_id ?? null,
      suggested_category_name: c?.suggested_category_name ?? null,
      confidence: c?.confidence ?? null,
      reasoning: c?.reasoning ?? null,
      status,
      updated_at: now,
    };
  });
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("transaction_labels")
    .upsert(rows, { onConflict: "transaction_id" });
  if (error) throw new Error(`stageSuggestions: ${error.message}`);
  return rows.length;
}

/** Staged rows for the review UI, newest transaction first. */
export async function listStagedLabels(
  tenantId: string,
  status?: string,
): Promise<LabelRow[]> {
  const sb = supabaseAdmin();
  let q = sb
    .from("transaction_labels")
    .select(
      "transaction_id, account_id, account_name, txn_date, amount, debit_or_credit, payee, description, suggested_account_id, suggested_category_name, confidence, reasoning, status, applied_at",
    )
    .eq("tenant_id", tenantId)
    .eq("source", "zoho") // PDF rows live separately (Overview summary), not here
    .order("txn_date", { ascending: false });
  if (status) q = q.eq("status", status);
  else q = q.neq("status", "unlabeled"); // raw un-labeled rows aren't reviewable
  q = q.limit(10000); // lift Supabase's default 1000-row cap
  const { data, error } = await q;
  if (error) throw new Error(`listStagedLabels: ${error.message}`);
  return (data ?? []) as LabelRow[];
}

/** Mark a row as written back to Zoho (categorized there). */
export async function markLabelApplied(
  tenantId: string,
  transactionId: string,
): Promise<void> {
  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await sb
    .from("transaction_labels")
    .update({ status: "applied", applied_at: now, updated_at: now })
    .eq("tenant_id", tenantId)
    .eq("transaction_id", transactionId);
  if (error) throw new Error(`markLabelApplied: ${error.message}`);
}

/** One staged row by transaction id (for write-back). */
export async function getLabelRow(
  tenantId: string,
  transactionId: string,
): Promise<LabelRow | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("transaction_labels")
    .select(
      "transaction_id, account_id, account_name, txn_date, amount, debit_or_credit, payee, description, suggested_account_id, suggested_category_name, confidence, reasoning, status, applied_at",
    )
    .eq("tenant_id", tenantId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw new Error(`getLabelRow: ${error.message}`);
  return (data as LabelRow) ?? null;
}

export async function countsByStatus(
  tenantId: string,
): Promise<Record<string, number>> {
  const sb = supabaseAdmin();
  const out: Record<string, number> = {
    unlabeled: 0,
    suggested: 0,
    confirmed: 0,
    applied: 0,
    rejected: 0,
  };
  for (const s of Object.keys(out)) {
    const { count } = await sb
      .from("transaction_labels")
      .select("transaction_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("source", "zoho")
      .eq("status", s);
    out[s] = count ?? 0;
  }
  return out;
}

export type PdfSummary = {
  fileName: string | null;
  count: number;
  grossRevenue: number;
  totalFees: number;
  net: number;
  feeBreakdown: Array<{ category: string; amount: number; count: number }>;
  revenueBySource: Array<{ category: string; amount: number; count: number }>;
  monthly: Array<{ ym: string; gross: number; fees: number; net: number }>;
};

/** Wipe the current PDF statement (we keep only one at a time). */
export async function clearPdfLabels(tenantId: string): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("transaction_labels")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("source", "pdf");
  if (error) throw new Error(`clearPdfLabels: ${error.message}`);
}

/** PDF rows of a given status, for the preview table (every extracted line). */
export async function listPdfTransactions(
  tenantId: string,
  status: string,
): Promise<
  Array<{
    date: string;
    description: string;
    amount: number;
    debit_or_credit: string;
    category: string;
  }>
> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("transaction_labels")
    .select("txn_date, description, payee, amount, debit_or_credit, suggested_category_name")
    .eq("tenant_id", tenantId)
    .eq("source", "pdf")
    .eq("status", status)
    .order("txn_date", { ascending: false })
    .limit(10000);
  if (error) throw new Error(`listPdfTransactions: ${error.message}`);
  return (data ?? []).map((r) => ({
    date: (r.txn_date as string) ?? "",
    description: (r.description as string) || (r.payee as string) || "",
    amount: Number(r.amount ?? 0),
    debit_or_credit: (r.debit_or_credit as string) ?? "",
    category: (r.suggested_category_name as string) || "Uncategorized",
  }));
}

/** Apply the previewed PDF: drop any previously-applied PDF, promote preview. */
export async function confirmPdfPreview(tenantId: string): Promise<number> {
  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  await sb
    .from("transaction_labels")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("source", "pdf")
    .eq("status", "confirmed");
  const { data, error } = await sb
    .from("transaction_labels")
    .update({ status: "confirmed", applied_at: now, updated_at: now })
    .eq("tenant_id", tenantId)
    .eq("source", "pdf")
    .eq("status", "preview")
    .select("transaction_id");
  if (error) throw new Error(`confirmPdfPreview: ${error.message}`);
  return data?.length ?? 0;
}

/** Discard a previewed (not-yet-applied) PDF. */
export async function cancelPdfPreview(tenantId: string): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("transaction_labels")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("source", "pdf")
    .eq("status", "preview");
  if (error) throw new Error(`cancelPdfPreview: ${error.message}`);
}

/** Overview-style summary of the uploaded PDF statement (source='pdf'):
 *  credit = revenue, debit = fee/deduction. Kept separate from Zoho data. */
// Internal transfers between the business's own accounts and capital movements
// (owner equity / drawings) are NOT revenue or expense — including them in a
// P&L-style summary distorts the totals and fee rate. Exclude them.
const PDF_EXCLUDED_CATEGORIES = new Set([
  "USD account",
  "PLAT BUS CHECKING",
  "Mercury Savings",
  "Mercury Checking",
  "B ACCOUNT",
  "Mercury Credit",
  "Retained Earnings",
  "Owner's Equity",
  "Opening Balance Offset",
  "Opening Balance Adjustments",
  "Drawings",
]);

export async function summarizePdf(
  tenantId: string,
  status: string = "confirmed",
): Promise<PdfSummary | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("transaction_labels")
    .select("account_name, txn_date, amount, debit_or_credit, suggested_category_name")
    .eq("tenant_id", tenantId)
    .eq("source", "pdf")
    .eq("status", status)
    .limit(10000);
  if (error) throw new Error(`summarizePdf: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return null;

  let grossRevenue = 0;
  let totalFees = 0;
  let fileName: string | null = null;
  const feeMap = new Map<string, { amount: number; count: number }>();
  const revMap = new Map<string, { amount: number; count: number }>();
  const monthMap = new Map<string, { gross: number; fees: number }>();

  for (const r of rows) {
    fileName = fileName ?? ((r.account_name as string) ?? null);
    const cat = (r.suggested_category_name as string) || "Uncategorized";
    if (PDF_EXCLUDED_CATEGORIES.has(cat)) continue; // internal transfers / equity
    const amt = Number(r.amount ?? 0);
    const ym = ((r.txn_date as string) ?? "").slice(0, 7);
    const mo = ym ? (monthMap.get(ym) ?? { gross: 0, fees: 0 }) : null;
    // Zoho: debit = money IN (deposit/revenue), credit = money OUT (fees/spend).
    if (r.debit_or_credit === "debit") {
      grossRevenue += amt;
      const e = revMap.get(cat) ?? { amount: 0, count: 0 };
      e.amount += amt;
      e.count += 1;
      revMap.set(cat, e);
      if (mo) mo.gross += amt;
    } else {
      totalFees += amt;
      const e = feeMap.get(cat) ?? { amount: 0, count: 0 };
      e.amount += amt;
      e.count += 1;
      feeMap.set(cat, e);
      if (mo) mo.fees += amt;
    }
    if (ym && mo) monthMap.set(ym, mo);
  }
  const toArr = (m: Map<string, { amount: number; count: number }>) =>
    [...m.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.amount - a.amount);

  const monthly = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, m]) => ({ ym, gross: m.gross, fees: m.fees, net: m.gross - m.fees }));

  return {
    fileName,
    count: rows.length,
    grossRevenue,
    totalFees,
    net: grossRevenue - totalFees,
    feeBreakdown: toArr(feeMap),
    revenueBySource: toArr(revMap),
    monthly,
  };
}

/** Cache raw uncategorized transactions in the DB as 'unlabeled' (no AI
 *  suggestion yet) so labeling runs read from the DB instead of re-fetching
 *  Zoho every time. Only inserts rows we don't already have (any status). */
export async function syncUncategorized(
  tenantId: string,
  txns: UncategorizedTxn[],
  source: "zoho" | "pdf" = "zoho",
): Promise<{ inserted: number; total: number }> {
  if (txns.length === 0) return { inserted: 0, total: 0 };
  const sb = supabaseAdmin();
  const existing = await getStagedTxnIds(tenantId);
  const now = new Date().toISOString();
  const rows = txns
    .filter((t) => !existing.has(t.transaction_id))
    .map((t) => ({
      transaction_id: t.transaction_id,
      tenant_id: tenantId,
      source,
      account_id: t.account_id,
      account_name: t.account_name,
      txn_date: t.date || null,
      amount: t.amount,
      debit_or_credit: t.debit_or_credit,
      payee: t.payee,
      description: t.description,
      status: "unlabeled",
      updated_at: now,
    }));
  if (rows.length > 0) {
    const { error } = await sb
      .from("transaction_labels")
      .upsert(rows, { onConflict: "transaction_id", ignoreDuplicates: true });
    if (error) throw new Error(`syncUncategorized: ${error.message}`);
  }
  return { inserted: rows.length, total: txns.length };
}

/** The un-labeled pool straight from the DB (no Zoho call), optionally within a
 *  date window. Shaped like UncategorizedTxn so the classifier can use it. */
export async function listUnlabeled(
  tenantId: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<UncategorizedTxn[]> {
  const sb = supabaseAdmin();
  let q = sb
    .from("transaction_labels")
    .select(
      "transaction_id, account_id, account_name, txn_date, amount, debit_or_credit, payee, description",
    )
    .eq("tenant_id", tenantId)
    .eq("status", "unlabeled")
    .order("txn_date", { ascending: false });
  if (opts.from) q = q.gte("txn_date", opts.from);
  if (opts.to) q = q.lte("txn_date", opts.to);
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`listUnlabeled: ${error.message}`);
  return (data ?? []).map((r) => ({
    transaction_id: r.transaction_id as string,
    account_id: r.account_id as string,
    account_name: (r.account_name as string) ?? "",
    date: (r.txn_date as string) ?? "",
    amount: Number(r.amount ?? 0),
    debit_or_credit: (r.debit_or_credit as string) ?? "",
    payee: (r.payee as string) ?? "",
    description: (r.description as string) ?? "",
  }));
}

/** Confirm a suggestion → record the category as confirmed in our ledger.
 *  Optionally override the category (when the reviewer edits it). */
export async function confirmLabel(
  tenantId: string,
  transactionId: string,
  overrideAccountId?: string,
): Promise<void> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("transaction_labels")
    .select("suggested_account_id")
    .eq("tenant_id", tenantId)
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) throw new Error(`confirmLabel(read): ${error.message}`);
  const accountId = overrideAccountId || (data?.suggested_account_id as string);
  if (!accountId) throw new Error("No category to apply for this transaction");

  const { error: upErr } = await sb
    .from("transaction_labels")
    .update({
      status: "confirmed",
      suggested_account_id: accountId,
      applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .eq("transaction_id", transactionId);
  if (upErr) throw new Error(`confirmLabel(update): ${upErr.message}`);
}

/** Bulk-confirm every still-suggested row whose confidence is >= minConfidence
 *  — one fast UPDATE, all marked confirmed in our ledger. */
export async function confirmAllSuggested(
  tenantId: string,
  minConfidence: number,
): Promise<{ confirmed: number; failed: number; remaining: number }> {
  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("transaction_labels")
    .update({ status: "confirmed", applied_at: now, updated_at: now })
    .eq("tenant_id", tenantId)
    .eq("source", "zoho")
    .eq("status", "suggested")
    .gte("confidence", minConfidence)
    .not("suggested_account_id", "is", null)
    .select("transaction_id");
  if (error) throw new Error(`confirmAllSuggested: ${error.message}`);
  return { confirmed: data?.length ?? 0, failed: 0, remaining: 0 };
}

export async function rejectLabel(
  tenantId: string,
  transactionId: string,
): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("transaction_labels")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("transaction_id", transactionId);
  if (error) throw new Error(`rejectLabel: ${error.message}`);
}

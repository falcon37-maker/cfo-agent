// Central registry for every category module. To add a new category,
// create the file in this folder and append it to ALL_CATEGORIES below.

import type { CategoryModule, QueryResult, TableColumn } from "./_base";
import { coreCategory } from "./core";
import { revenueCategory } from "./revenue";
import { pnlCategory } from "./pnl";
import { subscriptionsCategory } from "./subscriptions";
import { chargebacksCategory } from "./chargebacks";
import { storesCategory } from "./stores";
import { adSpendCategory } from "./ad_spend";
import { cogsCategory } from "./cogs";
import { trendsCategory } from "./trends";
import { forecastingCategory } from "./forecasting";
import { customerDataCategory } from "./customer_data";
import { refundsCategory } from "./refunds";
import { securityCategory } from "./security";
import { guidanceCategory } from "./guidance";
import { operationsCategory } from "./operations";

/** All 15 categories. Order matters for the classifier prompt — keep the
 *  most-used ones near the top so the model anchors on them first. */
export const ALL_CATEGORIES: CategoryModule[] = [
  coreCategory,
  revenueCategory,
  pnlCategory,
  subscriptionsCategory,
  chargebacksCategory,
  storesCategory,
  adSpendCategory,
  cogsCategory,
  refundsCategory,
  trendsCategory,
  forecastingCategory,
  customerDataCategory,
  operationsCategory,
  securityCategory,
  guidanceCategory,
];

export function getCategory(id: string): CategoryModule | null {
  return ALL_CATEGORIES.find((c) => c.id === id) ?? null;
}

/** Run a query template inside a category. Centralized so we can:
 *   - validate params via Zod once
 *   - decide text-vs-table mode based on table_threshold
 *   - format table columns consistently
 *  Throws on unknown query id or param validation failure — caller must
 *  catch and surface a friendly message. */
export async function runCategoryQuery(args: {
  category: CategoryModule;
  query_id: string;
  raw_params: unknown;
  tenantId: string;
}): Promise<QueryResult> {
  const q = args.category.queries.find((x) => x.id === args.query_id);
  if (!q) {
    throw new Error(
      `Unknown query "${args.query_id}" in category "${args.category.id}"`,
    );
  }
  const params = q.params_schema.parse(args.raw_params);
  const today = new Date().toISOString().slice(0, 10);
  const data = await q.run(params, { tenantId: args.tenantId, today });

  // Decide mode. If the template said "always text" (threshold null), or
  // the data isn't an array, or the array is small enough, send to Claude.
  const arr = Array.isArray(data) ? data : extractRowArray(data);
  if (
    q.table_threshold == null ||
    !arr ||
    arr.length <= q.table_threshold
  ) {
    return { mode: "text", data, query_id: q.id };
  }

  // Otherwise stream as a table.
  const columns = buildTableColumns(q, arr[0]);
  return {
    mode: "table",
    query_id: q.id,
    rows: arr as Record<string, unknown>[],
    columns,
    summary: `${arr.length} rows from ${args.category.name} · ${q.description}`,
  };
}

/** Try to pull an array-of-objects payload out of common result shapes:
 *  - directly an array
 *  - { rows: [...] }
 *  - { data: [...] }
 *  Returns null if none of those match. */
function extractRowArray(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.rows)) return d.rows as Record<string, unknown>[];
    if (Array.isArray(d.data)) return d.data as Record<string, unknown>[];
  }
  return null;
}

function buildTableColumns(
  q: CategoryModule["queries"][number],
  sample: unknown,
): TableColumn[] {
  // If the template declared explicit columns, use those (in order).
  if (q.table_columns && q.table_columns.length > 0) {
    return q.table_columns.map((key) => ({
      key,
      label: q.table_column_labels?.[key] ?? humanize(key),
      format: q.table_column_format?.[key] ?? guessFormat(key),
    }));
  }
  // Otherwise derive from the first row's keys.
  if (sample && typeof sample === "object") {
    return Object.keys(sample).map((key) => ({
      key,
      label: humanize(key),
      format: guessFormat(key),
    }));
  }
  return [];
}

function humanize(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function guessFormat(key: string): TableColumn["format"] {
  const k = key.toLowerCase();
  if (k === "date" || k.endsWith("_date") || k.endsWith("_at")) return "date";
  if (k.endsWith("_pct") || k === "margin") return "pct";
  if (k.includes("count") || k === "orders") return "int";
  if (
    k.includes("revenue") ||
    k.includes("profit") ||
    k.includes("spend") ||
    k.includes("cogs") ||
    k.includes("fees") ||
    k.includes("refunds") ||
    k.includes("amount") ||
    k === "roas"
  ) {
    return "money";
  }
  return "text";
}

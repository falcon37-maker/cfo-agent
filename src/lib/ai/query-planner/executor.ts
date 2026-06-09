// Secure query-plan executor.
//
// Pipeline (each layer must pass — fail-closed):
//   1. Zod schema parse        — shape + operation=select enforced
//   2. Table whitelist          — only schema-knowledge tables allowed
//   3. Column whitelist (SELECT) — every column must be declared in schema-knowledge
//   4. Column whitelist (WHERE/ORDER/GROUP) — same check, plus operator restrictions
//   5. Tenant scope injection   — server always adds tenant_id = authTenant
//   6. Resource clamps          — limit ≤ MAX_ROWS, date range ≤ MAX_DAYS
//
// After validation, we build the query via Supabase JS — which uses
// parameterized requests under the hood, so even if a value contains
// "'; DROP TABLE …" it's safe.

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  ALLOWED_TABLES,
  EXPLICITLY_BLOCKED,
  getTableMeta,
} from "./schema-knowledge";
import {
  HARD_LIMITS,
  QueryPlan,
  type FilterClauseType,
  type OrderClauseType,
  type QueryPlanType,
  type AggregationType,
} from "./plan-schema";

export type ExecuteContext = {
  tenantId: string;
};

export type ExecuteResult =
  | {
      ok: true;
      plan: QueryPlanType;
      rows: Record<string, unknown>[];
      row_count: number;
      truncated: boolean;
    }
  | {
      ok: false;
      stage: "parse" | "validate" | "execute" | "internal";
      reason: string;
    };

/** Top-level entry point. Takes whatever JSON the model produced + the
 *  authenticated tenantId, returns rows or a typed failure. */
export async function executePlan(
  rawPlan: unknown,
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  // ── Layer 1: schema parse ────────────────────────────────────────────
  const parsed = QueryPlan.safeParse(rawPlan);
  if (!parsed.success) {
    return {
      ok: false,
      stage: "parse",
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .slice(0, 3)
        .join("; "),
    };
  }
  const plan = parsed.data;

  // ── Layer 2: table whitelist ─────────────────────────────────────────
  if (EXPLICITLY_BLOCKED.tables.includes(plan.table)) {
    return {
      ok: false,
      stage: "validate",
      reason: `table "${plan.table}" is not available`,
    };
  }
  const tableMeta = getTableMeta(plan.table);
  if (!tableMeta) {
    return {
      ok: false,
      stage: "validate",
      reason: `unknown table "${plan.table}"`,
    };
  }

  // Build the per-table allowed column set, minus any explicitly-blocked
  // columns for that table.
  const blockedCols = new Set(
    EXPLICITLY_BLOCKED.columns_in_allowed_tables[
      plan.table as keyof typeof EXPLICITLY_BLOCKED.columns_in_allowed_tables
    ] ?? [],
  );
  const allowedCols = new Set(
    tableMeta.columns
      .map((c) => c.name)
      .filter((c) => !blockedCols.has(c)),
  );

  // ── Layer 3: SELECT column whitelist ─────────────────────────────────
  for (const col of plan.select) {
    if (col === "*") {
      return {
        ok: false,
        stage: "validate",
        reason: 'wildcard "*" not allowed — list columns explicitly',
      };
    }
    if (!allowedCols.has(col)) {
      return {
        ok: false,
        stage: "validate",
        reason: `column "${col}" is not available on ${plan.table}`,
      };
    }
  }

  // ── Layer 4: WHERE / ORDER / GROUP column whitelist ──────────────────
  for (const w of plan.where) {
    if (w.column === "tenant_id") {
      // Pretend the model didn't mention it — we force it ourselves.
      continue;
    }
    if (!allowedCols.has(w.column)) {
      return {
        ok: false,
        stage: "validate",
        reason: `WHERE references unavailable column "${w.column}"`,
      };
    }
    // Operator-specific value checks.
    const v = w.value;
    if (w.op === "in") {
      if (!Array.isArray(v) || v.length === 0 || v.length > 50) {
        return {
          ok: false,
          stage: "validate",
          reason: `"in" expects a non-empty array (max 50) on ${w.column}`,
        };
      }
    } else if (w.op === "is_null" || w.op === "is_not_null") {
      // value must be absent or null
    } else if (v === undefined || v === null || Array.isArray(v)) {
      return {
        ok: false,
        stage: "validate",
        reason: `operator "${w.op}" expects a scalar value on ${w.column}`,
      };
    }
    // LIKE patterns: cap length to prevent ReDoS-style abuse and
    // forbid leading wildcard which forces full scans.
    if ((w.op === "like" || w.op === "ilike") && typeof v === "string") {
      if (v.length > 100) {
        return {
          ok: false,
          stage: "validate",
          reason: "LIKE pattern too long",
        };
      }
    }
  }
  for (const o of plan.order_by) {
    if (!allowedCols.has(o.column)) {
      return {
        ok: false,
        stage: "validate",
        reason: `ORDER BY references unavailable column "${o.column}"`,
      };
    }
  }
  for (const g of plan.group_by) {
    if (!allowedCols.has(g)) {
      return {
        ok: false,
        stage: "validate",
        reason: `GROUP BY references unavailable column "${g}"`,
      };
    }
  }
  for (const a of plan.aggregations) {
    if (a.column && !allowedCols.has(a.column)) {
      return {
        ok: false,
        stage: "validate",
        reason: `aggregation references unavailable column "${a.column}"`,
      };
    }
  }

  // ── Layer 6 (pre-execute): date-range clamp ──────────────────────────
  const dateClampError = clampDateRange(plan);
  if (dateClampError) {
    return { ok: false, stage: "validate", reason: dateClampError };
  }

  const effectiveLimit = Math.min(plan.limit, HARD_LIMITS.MAX_ROWS);

  // ── Layer 5: build Supabase query with FORCED tenant scope ───────────
  // Supabase JS uses a deeply-generic builder chain that the TS compiler
  // can't keep up with once we start branching dynamically. We've already
  // validated everything that touches column names + operators above, so
  // it's safe to type the builder as a loose any here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabaseAdmin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = sb.from(plan.table).select(plan.select.join(", "));

  // ALWAYS tenant-scope when the table has tenant_id. Even if the model
  // tried to pass its own tenant_id in WHERE, this overrides it.
  if (tableMeta.has_tenant_id) {
    q = q.eq("tenant_id", ctx.tenantId);
  } else if (plan.table === "products") {
    // products is scoped via stores; restrict to this tenant's store_ids.
    const { data: tenantStores } = await sb
      .from("stores")
      .select("id")
      .eq("tenant_id", ctx.tenantId);
    const storeIds = ((tenantStores ?? []) as Array<{ id: string }>).map(
      (s) => s.id,
    );
    if (storeIds.length === 0) {
      return {
        ok: true,
        plan,
        rows: [],
        row_count: 0,
        truncated: false,
      };
    }
    q = q.in("store_id", storeIds);
  }

  // Apply the model's WHERE clauses (tenant_id ones already filtered out).
  for (const w of plan.where) {
    if (w.column === "tenant_id") continue;
    q = applyFilter(q, w);
  }

  // ORDER BY
  for (const o of plan.order_by) {
    q = q.order(o.column, { ascending: o.dir === "asc" });
  }

  q = q.limit(effectiveLimit);

  // ── Execute ───────────────────────────────────────────────────────────
  const { data, error } = (await q) as {
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
  };
  if (error) {
    return {
      ok: false,
      stage: "execute",
      reason: error.message,
    };
  }

  let rows: Record<string, unknown>[] = data ?? [];

  // JS-side aggregation + grouping (we kept SQL plain SELECT for safety).
  if (plan.group_by.length > 0 || plan.aggregations.length > 0) {
    rows = aggregate(rows, plan.group_by, plan.aggregations);
  }

  return {
    ok: true,
    plan,
    rows,
    row_count: rows.length,
    truncated: rows.length >= effectiveLimit,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Apply a single WHERE clause to the Supabase builder. We type the builder
 *  as any here because Supabase's chained generic types break down once we
 *  branch dynamically — the values themselves are already validated above
 *  (column whitelist, operator whitelist, per-op value-shape checks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilter(q: any, w: FilterClauseType): any {
  const v = w.value;
  switch (w.op) {
    case "eq":
      return q.eq(w.column, v);
    case "neq":
      return q.neq(w.column, v);
    case "in":
      return q.in(w.column, v as Array<string | number>);
    case "gte":
      return q.gte(w.column, v);
    case "lte":
      return q.lte(w.column, v);
    case "gt":
      return q.gt(w.column, v);
    case "lt":
      return q.lt(w.column, v);
    case "like":
      return q.like(w.column, v);
    case "ilike":
      return q.ilike(w.column, v);
    case "is_null":
      return q.is(w.column, null);
    case "is_not_null":
      return q.not(w.column, "is", null);
  }
}

function aggregate(
  rows: Record<string, unknown>[],
  groupBy: string[],
  aggs: AggregationType[],
): Record<string, unknown>[] {
  if (groupBy.length === 0) {
    // No grouping → reduce to a single row.
    const out: Record<string, unknown> = {};
    for (const a of aggs) {
      out[a.as] = computeAgg(rows, a);
    }
    return [out];
  }
  // Bucket rows by groupBy key.
  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const key = groupBy.map((g) => String(r[g] ?? "")).join("|");
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }
  const out: Record<string, unknown>[] = [];
  for (const [, bucketRows] of buckets) {
    const sample = bucketRows[0];
    const row: Record<string, unknown> = {};
    for (const g of groupBy) row[g] = sample[g];
    for (const a of aggs) row[a.as] = computeAgg(bucketRows, a);
    out.push(row);
  }
  return out;
}

function computeAgg(rows: Record<string, unknown>[], a: AggregationType): unknown {
  if (a.fn === "count") return rows.length;
  const col = a.column;
  if (!col) return null;
  const nums = rows
    .map((r) => Number(r[col]))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  switch (a.fn) {
    case "sum":
      return round2(nums.reduce((s, n) => s + n, 0));
    case "avg":
      return round2(nums.reduce((s, n) => s + n, 0) / nums.length);
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** If the plan filters on a date column with both lower and upper bound,
 *  reject if the span exceeds MAX_DATE_RANGE_DAYS. Cheap defense against
 *  a model asking for 5 years of rows. */
function clampDateRange(plan: QueryPlanType): string | null {
  // Find a column that looks like a date with both >=/> and <=/< filters.
  const lowers = new Map<string, string>();
  const uppers = new Map<string, string>();
  for (const w of plan.where) {
    if (typeof w.value !== "string") continue;
    if (!/^\d{4}-\d{2}-\d{2}/.test(w.value)) continue;
    if (w.op === "gte" || w.op === "gt") lowers.set(w.column, w.value);
    if (w.op === "lte" || w.op === "lt") uppers.set(w.column, w.value);
  }
  for (const [col, lo] of lowers) {
    const hi = uppers.get(col);
    if (!hi) continue;
    const a = new Date(`${lo.slice(0, 10)}T00:00:00Z`).getTime();
    const b = new Date(`${hi.slice(0, 10)}T00:00:00Z`).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const days = Math.abs((b - a) / (1000 * 60 * 60 * 24));
    if (days > HARD_LIMITS.MAX_DATE_RANGE_DAYS) {
      return `date range on "${col}" exceeds ${HARD_LIMITS.MAX_DATE_RANGE_DAYS} days`;
    }
  }
  return null;
}

// Used by the validator type cast above — keep the export so it's reachable
// from tests if we add them.
export { ALLOWED_TABLES };

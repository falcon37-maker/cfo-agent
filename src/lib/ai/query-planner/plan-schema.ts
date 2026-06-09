// Zod schema for the structured query plans the AI generates.
//
// The AI never writes SQL. It returns a JSON object matching this shape,
// which our executor turns into a parameterized Supabase JS query. Even
// a perfectly-crafted prompt-injection that produces malicious JSON
// can't escape this schema — `strict()` rejects unknown keys, the
// `operation` literal forbids anything other than SELECT, and the
// validator (next file) cross-checks tables/columns against the
// schema-knowledge whitelist.

import { z } from "zod";

/** Allowed comparison operators. Anything not in this list is rejected.
 *  We deliberately keep it small — every operator added is a new attack
 *  surface to think about. */
export const FilterOp = z.enum([
  "eq",
  "neq",
  "in",
  "gte",
  "lte",
  "gt",
  "lt",
  "like",
  "ilike",
  "is_null",
  "is_not_null",
]);
export type FilterOpType = z.infer<typeof FilterOp>;

const FilterValue = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(100), z.number()])).max(50),
]);

/** A single WHERE clause: column + op + value. */
export const FilterClause = z.object({
  column: z.string().min(1).max(64),
  op: FilterOp,
  value: FilterValue.optional(), // optional because is_null / is_not_null take no value
});
export type FilterClauseType = z.infer<typeof FilterClause>;

/** Sort spec: which column, which direction. Max 3 sort keys. */
export const OrderClause = z.object({
  column: z.string().min(1).max(64),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type OrderClauseType = z.infer<typeof OrderClause>;

/** JS-side aggregation (we never let SQL aggregate — it stays plain SELECT). */
export const Aggregation = z.object({
  fn: z.enum(["sum", "avg", "min", "max", "count"]),
  column: z.string().min(1).max(64).optional(), // omitted for count(*)
  as: z.string().min(1).max(64),
});
export type AggregationType = z.infer<typeof Aggregation>;

/** The full plan. `.strict()` rejects unknown top-level keys so the model
 *  can't sneak in `raw_sql`, `rpc`, `function`, etc. */
export const QueryPlan = z
  .object({
    /** ONLY "select" is accepted. Any other value is a hard reject. */
    operation: z.literal("select"),

    /** Table to read from. Validated against the whitelist downstream. */
    table: z.string().min(1).max(64),

    /** Columns to return. No "*" allowed — must be explicit names. */
    select: z.array(z.string().min(1).max(64)).min(1).max(25),

    /** WHERE clauses. Combined with AND. */
    where: z.array(FilterClause).max(15).default([]),

    /** ORDER BY. */
    order_by: z.array(OrderClause).max(3).default([]),

    /** GROUP BY columns. When present, `select` should contain those columns
     *  + the aggregations. We do the grouping in JS, not SQL. */
    group_by: z.array(z.string().min(1).max(64)).max(5).default([]),

    /** Aggregations applied AFTER fetching rows (JS-side). */
    aggregations: z.array(Aggregation).max(10).default([]),

    /** Hard cap on row count. Clamped to MAX_ROWS by the executor. */
    limit: z.number().int().positive().max(2000).default(100),

    /** One-sentence reason for this plan — for logs/audit. */
    reason: z.string().max(280).optional(),
  })
  .strict();

export type QueryPlanType = z.infer<typeof QueryPlan>;

/** Hard caps the executor enforces regardless of what the plan asked for. */
export const HARD_LIMITS = {
  MAX_ROWS: 500,
  MAX_DATE_RANGE_DAYS: 365,
  STATEMENT_TIMEOUT_MS: 5000,
} as const;

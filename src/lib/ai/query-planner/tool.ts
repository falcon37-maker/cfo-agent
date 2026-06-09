// Anthropic tool definition for dynamic schema-aware SQL queries.
//
// The model receives this tool alongside the schema description. When it
// needs data we don't have in the system-prompt snapshot, it calls
// `query_database` with a structured JSON plan; the route handler then
// runs that plan through the executor (which validates + executes
// safely) and feeds the rows back as a tool_result.
//
// Why this is safe:
//   - The tool's input_schema is the same shape as our Zod QueryPlan.
//   - Even if the model returns garbage, executePlan() rejects it.
//   - operation is locked to "select".
//   - Tables + columns are whitelisted in schema-knowledge.ts.
//   - tenant_id is always injected by the server.

import type Anthropic from "@anthropic-ai/sdk";
import { describeSchemaForModel } from "./schema-knowledge";

/** The single tool we expose. Returns a JSON object the model can read. */
export const QUERY_DATABASE_TOOL: Anthropic.Tool = {
  name: "query_database",
  description:
    "Fetch data from the business database. Use this whenever the user asks about a specific date, range, store, or metric that isn't already in the system-prompt snapshot. Returns rows of JSON. The query is validated server-side — invalid plans return an error you can correct on the next turn.",
  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["select"],
        description: "Only 'select' is supported. Read-only.",
      },
      table: {
        type: "string",
        description:
          "Table to read from. Must be one of the tables in the schema you were given.",
      },
      select: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit list of columns to return. Wildcard '*' is not allowed.",
        minItems: 1,
        maxItems: 25,
      },
      where: {
        type: "array",
        description:
          "WHERE clauses combined with AND. Don't include tenant_id — it's automatically applied.",
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            op: {
              type: "string",
              enum: [
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
              ],
            },
            value: {
              description:
                "Scalar (string/number/boolean/null) for most ops; array of scalars for 'in'; omitted for is_null/is_not_null.",
            },
          },
          required: ["column", "op"],
        },
        maxItems: 15,
      },
      order_by: {
        type: "array",
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            dir: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["column"],
        },
        maxItems: 3,
      },
      group_by: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
        description:
          "Group results by these columns. Aggregations are applied per group.",
      },
      aggregations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fn: {
              type: "string",
              enum: ["sum", "avg", "min", "max", "count"],
            },
            column: { type: "string" },
            as: { type: "string", description: "Alias for the result column" },
          },
          required: ["fn", "as"],
        },
        maxItems: 10,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "Max rows to return. Server caps at 500 anyway.",
      },
      reason: {
        type: "string",
        description: "One-sentence why — for audit logging, not the user.",
        maxLength: 280,
      },
    },
    required: ["operation", "table", "select"],
  },
};

/** Tool-usage guidance baked into the system prompt. Explains WHEN to
 *  reach for the tool and how to think about the schema. */
export function describeQueryToolUsage(): string {
  return `# Querying the database

You have one tool: query_database. Call it whenever the user asks about data that isn't already in the system-prompt snapshot — a specific date, a specific store, a comparison, a breakdown, anything not in the last-7-day reference numbers.

How to use it well:

- Don't say "I don't have that data" or "outside my window". If a question is about business data, the answer is in the database. Call the tool.
- Pick the most specific table. If the question is about subscriptions, use phx_summary_snapshots. If it's about Shopify P&L, use daily_pnl. If it's about ad platform breakdown, use daily_ad_spend.
- ALWAYS list explicit columns in 'select' — no wildcards.
- For single-day questions, filter range_from=range_to (for PHX) or date=that_date (for daily_pnl).
- For ranges, use { op: "gte", value: from } + { op: "lte", value: to }.
- Don't include tenant_id in WHERE — the server adds it automatically. Including it isn't an error but it's redundant.
- For totals, use aggregations: [{ fn: "sum", column: "revenue", as: "total_revenue" }]. The server runs the sum in JS after fetching rows.
- For comparisons (NOVA vs NURA), use group_by: ["store_id"] plus the aggregation.
- Keep limit reasonable — 100 default, 500 max. If you ask for more rows than needed you waste tokens displaying them.

Schema details follow below.

${describeSchemaForModel()}`;
}

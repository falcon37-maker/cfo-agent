// The MCP server for one tenant. A thin adapter: it re-exposes the existing
// read tools (src/lib/ai/tools.ts) and adds transaction-labeling tools that wrap
// src/lib/zoho/{labels,writeback,transactions}.ts. No business logic lives here.
//
// Stateless Streamable-HTTP: each request builds a fresh Server + transport and
// closes over `tenantId` (resolved from the bearer token in the route). The
// model never supplies a tenant.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { TOOLS, runTool } from "@/lib/ai/tools";
import {
  listUnlabeled,
  listStagedLabels,
  confirmLabel,
  getLabelRow,
  markLabelApplied,
} from "@/lib/zoho/labels";
import { categorizeInZoho } from "@/lib/zoho/writeback";
import { listChartAccounts } from "@/lib/zoho/transactions";
import { logToolCall } from "@/lib/mcp/tokens";
import {
  QUERY_DATABASE_TOOL,
  describeQueryToolUsage,
} from "@/lib/ai/query-planner/tool";
import { executePlan } from "@/lib/ai/query-planner/executor";
import { SYNC_TOOLS, SYNC_TOOL_NAMES, runSyncTool } from "@/lib/mcp/sync-tools";

// ── Labeling tools (NEW) — JSON Schema, same shape as the read TOOLS ──
const LABEL_TOOLS: Tool[] = [
  {
    name: "list_zoho_categories",
    description:
      "List the Zoho chart of accounts (id, name, type). Use this to pick a valid category id before labeling a transaction.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_uncategorized_transactions",
    description:
      "List Zoho bank transactions that still need a category (uncategorized). Optionally filter by date range and limit the count.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "start date YYYY-MM-DD" },
        to: { type: "string", description: "end date YYYY-MM-DD" },
        limit: { type: "number", description: "max rows (default 100)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_staged_labels",
    description:
      "List transactions that have been labeled, filtered by status: suggested (AI proposal), confirmed (chosen, not yet in Zoho), applied (pushed to Zoho), or rejected.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["suggested", "confirmed", "applied", "rejected", "unlabeled"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "label_transaction",
    description:
      "Record a chosen Zoho category for a transaction in the CFO Agent ledger (status → confirmed). This does NOT push to Zoho yet — call apply_label_to_zoho for that. account_id is a Zoho chart-of-accounts id from list_zoho_categories.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        account_id: {
          type: "string",
          description: "Zoho chart-of-accounts id (the target category)",
        },
      },
      required: ["transaction_id", "account_id"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_label_to_zoho",
    description:
      "Push the confirmed category to Zoho Books — actually categorize the bank transaction there, then mark our row applied. Call label_transaction first.",
    inputSchema: {
      type: "object",
      properties: { transaction_id: { type: "string" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
  },
];

const READ_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// The flexible SQL-plan tool — same one the in-app chat uses. Lets Claude
// answer ANY data question (Paysight, subscriptions, custom breakdowns) that
// the fixed read tools above don't cover. The full schema + usage rules
// (including the Paysight billed-only revenue rule) are appended to the
// description because MCP has no separate system prompt to carry them.
const QUERY_TOOL: Tool = {
  name: QUERY_DATABASE_TOOL.name,
  description: `${QUERY_DATABASE_TOOL.description}\n\n${describeQueryToolUsage()}`,
  inputSchema: QUERY_DATABASE_TOOL.input_schema as Tool["inputSchema"],
};

function toolList(): Tool[] {
  const read: Tool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as Tool["inputSchema"],
  }));
  return [...read, QUERY_TOOL, ...SYNC_TOOLS, ...LABEL_TOOLS];
}

type Args = Record<string, unknown>;

async function applyLabelToZoho(tenantId: string, transactionId: string) {
  const row = await getLabelRow(tenantId, transactionId);
  if (!row) throw new Error(`Transaction ${transactionId} not found`);
  if (!row.suggested_account_id) {
    throw new Error(
      "No category set — call label_transaction first to choose a Zoho category.",
    );
  }

  // The target account's TYPE decides the Zoho endpoint (writeback branches on it).
  const coa = await listChartAccounts(tenantId);
  const target = coa.find((a) => a.account_id === row.suggested_account_id);
  if (!target) {
    throw new Error(
      `Chosen category ${row.suggested_account_id} is not in the Zoho chart of accounts.`,
    );
  }

  await categorizeInZoho(tenantId, {
    transactionId,
    bankAccountId: row.account_id,
    targetAccountId: row.suggested_account_id,
    targetAccountType: target.account_type,
    amount: Number(row.amount ?? 0),
    date: row.txn_date ?? "",
    description: row.description ?? undefined,
    debitOrCredit: row.debit_or_credit ?? "debit",
  });
  await markLabelApplied(tenantId, transactionId);
  return { ok: true, transaction_id: transactionId, status: "applied" };
}

async function callTool(
  name: string,
  args: Args,
  tenantId: string,
): Promise<unknown> {
  // Read tools reuse the existing executor 1:1.
  if (READ_TOOL_NAMES.has(name)) {
    const r = await runTool(name, args, { tenantId });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  // Sync tools — pull fresh data from external providers on demand.
  if (SYNC_TOOL_NAMES.has(name)) {
    return runSyncTool(name, args, tenantId);
  }

  // Flexible SQL-plan tool — validated + tenant-scoped by executePlan.
  if (name === QUERY_DATABASE_TOOL.name) {
    const result = await executePlan(args, { tenantId });
    if (!result.ok) {
      throw new Error(`${result.stage}: ${result.reason}`);
    }
    return {
      row_count: result.row_count,
      truncated: result.truncated,
      rows: result.rows,
    };
  }

  switch (name) {
    case "list_zoho_categories": {
      const coa = await listChartAccounts(tenantId);
      return coa.map((a) => ({
        id: a.account_id,
        name: a.account_name,
        type: a.account_type,
      }));
    }
    case "list_uncategorized_transactions":
      return listUnlabeled(tenantId, {
        from: typeof args.from === "string" ? args.from : undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        limit: typeof args.limit === "number" ? args.limit : 100,
      });
    case "list_staged_labels":
      return listStagedLabels(
        tenantId,
        typeof args.status === "string" ? args.status : undefined,
      );
    case "label_transaction": {
      const transactionId = String(args.transaction_id ?? "");
      const accountId = String(args.account_id ?? "");
      if (!transactionId || !accountId) {
        throw new Error("transaction_id and account_id are required");
      }
      await confirmLabel(tenantId, transactionId, accountId);
      return { ok: true, transaction_id: transactionId, status: "confirmed" };
    }
    case "apply_label_to_zoho":
      return applyLabelToZoho(tenantId, String(args.transaction_id ?? ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Build a fresh MCP server for this tenant and handle one HTTP request.
 *  `token` is the bearer token used, recorded in the activity log. */
export async function handleMcpRequest(
  req: Request,
  tenantId: string,
  token: string,
): Promise<Response> {
  const server = new Server(
    { name: "cfo-agent", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Args;
    const startedAt = Date.now();
    try {
      const data = await callTool(name, args, tenantId);
      await logToolCall({
        tenantId, token, toolName: name, args,
        ok: true, durationMs: Date.now() - startedAt,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await logToolCall({
        tenantId, token, toolName: name, args,
        ok: false, error: message, durationMs: Date.now() - startedAt,
      });
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Stateless: no session id — each request is self-contained (serverless-friendly).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

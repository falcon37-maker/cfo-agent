// "security" — audit / access / who-did-what.
//
// DB tables used:
//   chat_audit_log     (AI-triggered writes — empty in Phase A read-only)
//   cogs_entries       (submitted_by, submitted_at)
//   ad_spend_entries   (submitted_by, submitted_at)
//   tenant_memberships (who has access to this tenant + their role)
//
// Possible questions this handles:
//   - "who edited COGS last week?"
//   - "who logged ad spend yesterday?"
//   - "who has access to this workspace?"
//   - "show audit log"
//   - "any AI-triggered changes?"
//
// Role gate: admin/owner only — viewer/manager should not see who-did-what
// across the org.

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CategoryModule } from "./_base";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rangeSchema = z
  .object({
    days: z.number().int().positive().max(180).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
  })
  .refine(
    (v) => v.days != null || (v.from != null && v.to != null),
    "Provide either { days } or { from, to }",
  );

type RangeInput = z.infer<typeof rangeSchema>;

function resolveRange(input: RangeInput) {
  if (input.from && input.to) {
    const days = diffDays(input.from, input.to) + 1;
    return { from: input.from, to: input.to, days };
  }
  const days = input.days ?? 14;
  const to = new Date().toISOString().slice(0, 10);
  const from = addDays(to, -(days - 1));
  return { from, to, days };
}

export const securityCategory: CategoryModule = {
  id: "security",
  name: "Security & Audit",

  description:
    "Audit trail and access questions: who edited a value when, who has access to this workspace, what AI-triggered changes happened. Restricted to admin/owner roles.",

  examples: [
    "who edited COGS last week?",
    "who logged ad spend yesterday?",
    "who has access to this workspace?",
    "show audit log",
    "list team members",
    "any AI-triggered changes recently?",
  ],

  prompt: `# Mode: Security & Audit

The user is asking about who did what or who has access.

Reply rules:
- This category is admin/owner only. If a manager or viewer somehow lands here, decline politely and point them to /settings/team.
- Don't show emails of users who aren't part of this workspace.
- For audit-log questions, mention "no AI-triggered changes yet" plainly — Phase A is read-only.
- Be specific about timestamps when relevant — they're the whole point of audit trails.`,

  required_roles: ["owner", "admin"],

  queries: [
    {
      id: "recent_data_edits",
      description:
        "List recent manual data edits (COGS + ad spend entries) with who submitted and when.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        const [cogs, ads] = await Promise.all([
          sb
            .from("cogs_entries")
            .select("date, store_id, cogs, submitted_by, submitted_at")
            .eq("tenant_id", ctx.tenantId)
            .gte("submitted_at", `${spec.from}T00:00:00Z`)
            .lte("submitted_at", `${spec.to}T23:59:59Z`)
            .order("submitted_at", { ascending: false })
            .limit(30),
          sb
            .from("ad_spend_entries")
            .select("date, store_id, amount, submitted_by, submitted_at")
            .eq("tenant_id", ctx.tenantId)
            .gte("submitted_at", `${spec.from}T00:00:00Z`)
            .lte("submitted_at", `${spec.to}T23:59:59Z`)
            .order("submitted_at", { ascending: false })
            .limit(30),
        ]);
        const rows: Array<{
          type: string;
          date: string;
          store_id: string;
          amount: number;
          by: string;
          at: string;
        }> = [];
        for (const c of (cogs.data ?? []) as Array<{
          date: string;
          store_id: string;
          cogs: number | string;
          submitted_by: string | null;
          submitted_at: string;
        }>) {
          rows.push({
            type: "COGS",
            date: c.date,
            store_id: c.store_id,
            amount: round(Number(c.cogs)),
            by: c.submitted_by ?? "—",
            at: String(c.submitted_at).slice(0, 19).replace("T", " "),
          });
        }
        for (const a of (ads.data ?? []) as Array<{
          date: string;
          store_id: string;
          amount: number | string;
          submitted_by: string | null;
          submitted_at: string;
        }>) {
          rows.push({
            type: "Ad Spend",
            date: a.date,
            store_id: a.store_id,
            amount: round(Number(a.amount)),
            by: a.submitted_by ?? "—",
            at: String(a.submitted_at).slice(0, 19).replace("T", " "),
          });
        }
        rows.sort((x, y) => y.at.localeCompare(x.at));
        return rows.slice(0, 40);
      },
      table_threshold: 8,
      table_columns: ["at", "type", "date", "store_id", "amount", "by"],
      table_column_labels: {
        at: "When",
        type: "Type",
        date: "For Date",
        store_id: "Store",
        amount: "Amount",
        by: "By",
      },
    },
    {
      id: "list_members",
      description:
        "List everyone who has access to this workspace + their role.",
      params_schema: z.object({}),
      run: async (_in, ctx) => {
        const sb = supabaseAdmin();
        const { data } = await sb
          .from("tenant_memberships")
          .select("user_id, role, created_at")
          .eq("tenant_id", ctx.tenantId)
          .order("created_at", { ascending: true });
        return (data ?? []).map((r) => ({
          user_id: r.user_id,
          role: r.role,
          since: String(r.created_at ?? "").slice(0, 10),
        }));
      },
      table_threshold: null,
    },
    {
      id: "ai_audit_log",
      description:
        "List recent AI-triggered writes from chat_audit_log. Phase A is read-only so this should be empty.",
      params_schema: rangeSchema,
      run: async (rawIn, ctx) => {
        const raw = rawIn as RangeInput;
        const spec = resolveRange(raw);
        const sb = supabaseAdmin();
        const { data } = await sb
          .from("chat_audit_log")
          .select(
            "tool_name, target_table, target_pk, status, created_at",
          )
          .eq("tenant_id", ctx.tenantId)
          .gte("created_at", `${spec.from}T00:00:00Z`)
          .lte("created_at", `${spec.to}T23:59:59Z`)
          .order("created_at", { ascending: false })
          .limit(50);
        return (data ?? []).map((r) => ({
          at: String(r.created_at).slice(0, 19).replace("T", " "),
          tool: r.tool_name,
          table: r.target_table,
          target: JSON.stringify(r.target_pk),
          status: r.status,
        }));
      },
      table_threshold: null,
    },
  ],

  fallback_suggestions: [
    "who has admin access?",
    "show me recent COGS entries",
    "any AI-triggered changes?",
  ],
};

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// POST /api/chat/confirm   { pending_id, action: "confirm" | "cancel" }
//
// Resolves a pending_confirmations row. Strict security gates BEFORE any
// write touches the DB:
//
//   1. Auth (Supabase session cookie).
//   2. Role gate — viewer rejected at 403.
//   3. Per-user advisory lock — only one in-flight confirm per user at a
//      time. Stops accidental double-clicks from double-writing.
//   4. Row lock on the pending_confirmations row (SELECT … FOR UPDATE).
//   5. Whitelist re-check: tool_name + target_table must be in the
//      central whitelist. Even if the pending row says otherwise, we
//      refuse if either drifts from what the writers know about.
//   6. Tenant scope re-check: pending.tenant_id must match the
//      authenticated tenant — we never trust what's in the row.
//   7. After-value sanity re-check (amount bounds, date bounds).
//   8. Apply write inside a TX. Audit log + status update inside the
//      same TX so partial state is impossible.
//
// On confirm: applies + audits. On cancel: marks cancelled.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { PoolClient } from "pg";
import { requireTenant } from "@/lib/tenant";
import { withTransaction } from "@/lib/db/direct";
import { writeAuditEntry } from "@/lib/ai/edit/audit";
import {
  isEditableTable,
  validateAmount,
  validateDate,
  validateStoreId,
} from "@/lib/ai/edit/whitelist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  pending_id: z.uuid(),
  action: z.enum(["confirm", "cancel"]),
});

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[/api/chat/confirm] uncaught:", e);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Couldn't apply that change. Please try again.",
      },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────
  let tenant;
  try {
    tenant = await requireTenant();
  } catch {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Your session expired. Please refresh and sign in again.",
      },
      { status: 401 },
    );
  }
  if (tenant.role === "viewer") {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "Your role doesn't allow edits.",
      },
      { status: 403 },
    );
  }

  // ── Body validation ────────────────────────────────────────────────
  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Bad request." },
      { status: 400 },
    );
  }

  // ── Transactional apply ────────────────────────────────────────────
  const result = await withTransaction(async (client) => {
    // Per-user advisory lock — pg_advisory_xact_lock(int8) takes a single
    // int8 key derived from the user's uuid. Lock auto-releases at TX end.
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      userIdToLockKey(tenant.user_id),
    ]);

    // Lock + fetch pending row.
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      session_id: string;
      message_id: string | null;
      user_id: string | null;
      tool_name: string;
      target_table: string;
      target_pk: Record<string, unknown>;
      before_value: Record<string, unknown> | null;
      after_value: Record<string, unknown>;
      human_summary: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, tenant_id, session_id, message_id, user_id,
              tool_name, target_table, target_pk, before_value, after_value,
              human_summary, status, expires_at
       FROM pending_confirmations
       WHERE id = $1
       FOR UPDATE`,
      [body.pending_id],
    );
    if (rows.length === 0) {
      return { ok: false as const, status: 404, message: "That edit is no longer pending." };
    }
    const p = rows[0];

    // Tenant lockdown — never trust the stored value.
    if (p.tenant_id !== tenant.id) {
      console.warn(
        `[/api/chat/confirm] tenant mismatch: pending ${p.tenant_id} vs auth ${tenant.id}`,
      );
      return { ok: false as const, status: 403, message: "Not your edit." };
    }
    if (p.status !== "pending") {
      return {
        ok: false as const,
        status: 409,
        message: `Already ${p.status}.`,
        prior_status: p.status as "confirmed" | "cancelled" | "expired",
      };
    }
    if (new Date(p.expires_at).getTime() < Date.now()) {
      await client.query(
        `UPDATE pending_confirmations SET status='expired', resolved_at=NOW() WHERE id=$1`,
        [p.id],
      );
      return {
        ok: false as const,
        status: 410,
        message: "That edit expired before you confirmed it.",
      };
    }

    // Whitelist re-check — even if the row claims an exotic table, we
    // refuse unless it's one of our editable tables AND the tool name
    // matches our hand-written writers.
    if (!isEditableTable(p.target_table)) {
      console.error(
        `[/api/chat/confirm] non-editable table on pending row: ${p.target_table}`,
      );
      return {
        ok: false as const,
        status: 400,
        message: "That kind of edit isn't supported.",
      };
    }
    const knownTools = [
      "update_ad_spend",
      "update_cogs",
      "update_manual_revenue",
    ];
    if (!knownTools.includes(p.tool_name)) {
      console.error(
        `[/api/chat/confirm] unknown tool on pending row: ${p.tool_name}`,
      );
      return {
        ok: false as const,
        status: 400,
        message: "That kind of edit isn't supported.",
      };
    }

    // Cancel path — no write, just status flip.
    if (body.action === "cancel") {
      await client.query(
        `UPDATE pending_confirmations SET status='cancelled', resolved_at=NOW() WHERE id=$1`,
        [p.id],
      );
      return {
        ok: true as const,
        applied: false,
        summary: p.human_summary,
        status_text: "cancelled" as const,
      };
    }

    // ── Apply the write — final per-tool path ────────────────────────
    let applied = false;
    try {
      switch (p.tool_name) {
        case "update_ad_spend":
          applied = await applyAdSpendUpdate(client, p, tenant.id);
          break;
        case "update_cogs":
          applied = await applyCogsUpdate(client, p, tenant.id);
          break;
        case "update_manual_revenue":
          applied = await applyManualRevenueUpdate(client, p, tenant.id);
          break;
      }
    } catch (e) {
      console.error(
        `[/api/chat/confirm] write failed (${p.tool_name}):`,
        (e as Error).message,
      );
      return {
        ok: false as const,
        status: 500,
        message: "Write didn't go through. Please try again.",
      };
    }
    if (!applied) {
      return {
        ok: false as const,
        status: 500,
        message: "Write didn't go through. Please try again.",
      };
    }

    await writeAuditEntry(client, {
      tenantId: p.tenant_id,
      sessionId: p.session_id,
      messageId: p.message_id,
      userId: p.user_id,
      toolName: p.tool_name,
      targetTable: p.target_table,
      targetPk: p.target_pk,
      beforeValue: p.before_value,
      afterValue: p.after_value,
    });

    await client.query(
      `UPDATE pending_confirmations SET status='confirmed', resolved_at=NOW() WHERE id=$1`,
      [p.id],
    );

    return {
      ok: true as const,
      applied: true,
      summary: p.human_summary,
      status_text: "applied" as const,
    };
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: "rejected",
        message: result.message,
        prior_status:
          "prior_status" in result ? result.prior_status : undefined,
      },
      { status: result.status ?? 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    applied: result.applied,
    summary: result.summary,
    status: result.status_text,
  });
}

// ─── Per-tool writers ───────────────────────────────────────────────────
//
// Each writer:
//   1. Re-validates the after_value using the whitelist (defense in depth).
//   2. Forces tenant_id from the authenticated context (never trusts row).
//   3. Uses parameterized queries — no string interpolation anywhere.

type Pending = {
  tenant_id: string;
  user_id: string | null;
  target_pk: Record<string, unknown>;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown>;
};

async function applyAdSpendUpdate(
  client: PoolClient,
  p: Pending,
  authTenantId: string,
): Promise<boolean> {
  const storeId = validateStoreId(p.target_pk.store_id);
  const date = validateDate(p.target_pk.date);
  const amount = validateAmount(p.after_value.total_amount, "ad spend");
  const reason =
    typeof p.after_value.reason === "string"
      ? p.after_value.reason.slice(0, 280)
      : null;
  const submittedBy = reason ? `AI edit: ${reason}` : "AI edit (chat)";

  // 1. Replace the audit row.
  await client.query(
    `DELETE FROM ad_spend_entries
     WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [authTenantId, storeId, date],
  );
  await client.query(
    `INSERT INTO ad_spend_entries
       (tenant_id, store_id, date, amount, submitted_by, submitted_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [authTenantId, storeId, date, amount, submittedBy],
  );

  // 2. Mirror into daily_ad_spend (the authoritative read-side total).
  //    Manual chat edits use platform='facebook' to match the /ads page.
  await client.query(
    `INSERT INTO daily_ad_spend
       (tenant_id, store_id, date, platform, spend, currency, synced_at)
     VALUES ($1, $2, $3, 'facebook', $4, 'USD', NOW())
     ON CONFLICT (store_id, date, platform)
     DO UPDATE SET spend = EXCLUDED.spend, synced_at = NOW()`,
    [authTenantId, storeId, date, amount],
  );

  // 3. Roll up daily_pnl.ad_spend + recompute profit fields for that day.
  await rollupDailyPnl(client, authTenantId, storeId, date);
  return true;
}

/** Recompute daily_pnl.{ad_spend, gross/net profit, margin_pct} from the
 *  current state of daily_ad_spend and existing cogs/revenue figures.
 *  Mirrors recomputeAdSpendFor() in src/app/ads/actions.ts so chat edits
 *  affect downstream reads identically to /ads page edits. */
async function rollupDailyPnl(
  client: PoolClient,
  tenantId: string,
  storeId: string,
  date: string,
): Promise<void> {
  const { rows: spendRows } = await client.query<{ total: string | number }>(
    `SELECT COALESCE(SUM(spend), 0) AS total
       FROM daily_ad_spend
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [tenantId, storeId, date],
  );
  const totalSpend = Number(spendRows[0]?.total ?? 0);

  const { rows: pnlRows } = await client.query<{
    revenue: string | number | null;
    cogs: string | number | null;
    fees: string | number | null;
    refunds: string | number | null;
    shipping_cost: string | number | null;
    order_count: number | null;
  }>(
    `SELECT revenue, cogs, fees, refunds, shipping_cost, order_count
       FROM daily_pnl
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [tenantId, storeId, date],
  );
  const pnl = pnlRows[0];
  // Phase 2: daily_pnl.revenue is already net of refunds (Shopify "Net sales").
  // Do NOT subtract refunds again — that was the old double-subtraction bug
  // that made stores with refunds show artificially low net profit.
  const revenue = Number(pnl?.revenue ?? 0);
  const cogs = Number(pnl?.cogs ?? 0);
  const fees = Number(pnl?.fees ?? 0);
  const refunds = Number(pnl?.refunds ?? 0);
  const shipping = Number(pnl?.shipping_cost ?? 0);
  const grossProfit = revenue - cogs;
  const netProfit = revenue - cogs - fees - totalSpend;
  const marginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  await client.query(
    `INSERT INTO daily_pnl
       (tenant_id, store_id, date, revenue, cogs, fees, refunds,
        ad_spend, shipping_cost, gross_profit, net_profit, margin_pct,
        order_count, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (store_id, date)
     DO UPDATE SET
       ad_spend = EXCLUDED.ad_spend,
       gross_profit = EXCLUDED.gross_profit,
       net_profit = EXCLUDED.net_profit,
       margin_pct = EXCLUDED.margin_pct,
       computed_at = NOW()`,
    [
      tenantId,
      storeId,
      date,
      round2(revenue),
      round2(cogs),
      round2(fees),
      round2(refunds),
      round2(totalSpend),
      round2(shipping),
      round2(grossProfit),
      round2(netProfit),
      round2(marginPct),
      Number(pnl?.order_count ?? 0),
    ],
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function applyCogsUpdate(
  client: PoolClient,
  p: Pending,
  authTenantId: string,
): Promise<boolean> {
  const storeId = validateStoreId(p.target_pk.store_id);
  const date = validateDate(p.target_pk.date);
  const amount = validateAmount(p.after_value.total_amount, "COGS");
  const reason =
    typeof p.after_value.reason === "string"
      ? p.after_value.reason.slice(0, 280)
      : null;
  const submittedBy = reason ? `AI edit: ${reason}` : "AI edit (chat)";

  await client.query(
    `DELETE FROM cogs_entries
     WHERE tenant_id = $1 AND store_id = $2 AND date = $3`,
    [authTenantId, storeId, date],
  );
  await client.query(
    `INSERT INTO cogs_entries
       (tenant_id, store_id, date, cogs, submitted_by, submitted_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [authTenantId, storeId, date, amount, submittedBy],
  );

  // Mirror into daily_pnl.cogs so downstream P&L queries see the change.
  await client.query(
    `INSERT INTO daily_pnl
       (tenant_id, store_id, date, revenue, cogs, fees, refunds,
        ad_spend, shipping_cost, gross_profit, net_profit, margin_pct,
        order_count, computed_at)
     VALUES (
       $1, $2, $3,
       COALESCE((SELECT revenue FROM daily_pnl WHERE tenant_id=$1 AND store_id=$2 AND date=$3), 0),
       $4,
       COALESCE((SELECT fees FROM daily_pnl WHERE tenant_id=$1 AND store_id=$2 AND date=$3), 0),
       COALESCE((SELECT refunds FROM daily_pnl WHERE tenant_id=$1 AND store_id=$2 AND date=$3), 0),
       COALESCE((SELECT ad_spend FROM daily_pnl WHERE tenant_id=$1 AND store_id=$2 AND date=$3), 0),
       COALESCE((SELECT shipping_cost FROM daily_pnl WHERE tenant_id=$1 AND store_id=$2 AND date=$3), 0),
       0, 0, 0,
       COALESCE((SELECT order_count FROM daily_pnl WHERE tenant_id=$1 AND store_id=$2 AND date=$3), 0),
       NOW()
     )
     ON CONFLICT (store_id, date)
     DO UPDATE SET cogs = EXCLUDED.cogs, computed_at = NOW()`,
    [authTenantId, storeId, date, amount],
  );
  // Recompute profit fields with new cogs value.
  await rollupDailyPnl(client, authTenantId, storeId, date);
  return true;
}

async function applyManualRevenueUpdate(
  client: PoolClient,
  p: Pending,
  authTenantId: string,
): Promise<boolean> {
  const storeId =
    p.target_pk.store_id != null && p.target_pk.store_id !== ""
      ? validateStoreId(p.target_pk.store_id)
      : null;
  const date = validateDate(p.target_pk.date);
  const revenueType = String(p.target_pk.revenue_type ?? "").trim();
  if (!revenueType) throw new Error("revenue_type missing");
  const amount = validateAmount(p.after_value.total_amount, "revenue amount");
  const reason =
    typeof p.after_value.reason === "string"
      ? p.after_value.reason.slice(0, 280)
      : "AI edit (chat)";

  if (storeId) {
    await client.query(
      `DELETE FROM manual_revenue_entries
       WHERE tenant_id = $1 AND store_id = $2 AND date = $3 AND revenue_type = $4`,
      [authTenantId, storeId, date, revenueType],
    );
  } else {
    await client.query(
      `DELETE FROM manual_revenue_entries
       WHERE tenant_id = $1 AND store_id IS NULL AND date = $2 AND revenue_type = $3`,
      [authTenantId, date, revenueType],
    );
  }
  await client.query(
    `INSERT INTO manual_revenue_entries
       (tenant_id, store_id, date, revenue_type, amount, notes, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [authTenantId, storeId, date, revenueType, amount, reason, p.user_id],
  );
  return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Map a UUID string to a stable int8 advisory-lock key. Postgres'
 *  pg_advisory_xact_lock takes a bigint; we hash the UUID into one.
 *  Collisions are tolerable — locks are advisory and per-transaction. */
function userIdToLockKey(uuid: string): string {
  // FNV-1a 64-bit hash. We use BigInt() constructor instead of bigint
  // literals (those need ES2020; this project targets ES2017).
  let h = BigInt("0xcbf29ce484222325");
  const PRIME = BigInt("0x100000001b3");
  const MASK64 = BigInt("0xffffffffffffffff");
  for (const c of uuid) {
    h ^= BigInt(c.charCodeAt(0));
    h = (h * PRIME) & MASK64;
  }
  // pg expects a signed int8; mask into the positive int64 range.
  const SIGNED_MAX = BigInt("0x7fffffffffffffff");
  return (h & SIGNED_MAX).toString();
}

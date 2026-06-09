// Phase 2 daily validators.
//
// Each function returns a list of issues found. The cron runner persists
// them into data_validation_log so the dashboard can surface a warning
// when anything is open.
//
// All checks are read-only — they only inspect what we've already synced,
// so they're safe to re-run any time.

import { supabaseAdmin } from "@/lib/supabase/admin";

export type Severity = "info" | "warn" | "error";

export type ValidationIssue = {
  tenant_id: string;
  store_id: string | null;
  date: string | null;
  check_name: string;
  severity: Severity;
  message: string;
  details: Record<string, unknown>;
};

/** 1. Net revenue should never be negative unless it's a legitimate
 *  refund-of-prior-day scenario (gross=$0, refund>0). When gross > 0
 *  but net goes negative, our discount/refund formula is broken. */
export async function checkNegativeNetRevenue(
  tenantId: string,
  windowDays = 30,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const from = isoDaysAgo(windowDays);
  const { data, error } = await sb
    .from("daily_orders")
    .select("store_id, date, gross_sales, discounts, refunds, net_revenue")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lt("net_revenue", 0);
  if (error) throw new Error(`checkNegativeNetRevenue: ${error.message}`);
  return (data ?? [])
    // Exclude legitimate refund-only days (gross == 0, refund > 0). Those
    // are real Shopify behaviour — a refund issued for a sale that came in
    // before the date window — not a math error on our side.
    .filter((r) => Number(r.gross_sales) > 0)
    .map((r) => ({
      tenant_id: tenantId,
      store_id: r.store_id as string,
      date: r.date as string,
      check_name: "negative_net_revenue",
      severity: "error" as const,
      message: `${r.store_id} ${r.date}: net revenue ${money(r.net_revenue)} is negative despite gross ${money(r.gross_sales)} — discount/refund formula likely wrong`,
      details: {
        gross_sales: Number(r.gross_sales),
        discounts: Number(r.discounts),
        refunds: Number(r.refunds),
        net_revenue: Number(r.net_revenue),
      },
    }));
}

/** 2. Active stores with credentials should produce SOME orders over the
 *  last N days. We only flag stores that HAVE credentials configured —
 *  unconfigured stores are caught by the credentials-missing check below
 *  rather than spamming "inactive" warnings for stores we can't sync. */
export async function checkInactiveStores(
  tenantId: string,
  windowDays = 7,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const from = isoDaysAgo(windowDays);
  const { data: stores, error: sErr } = await sb
    .from("stores")
    .select("id, shopify_domain, shopify_token_encrypted, shopify_client_id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (sErr) throw new Error(`checkInactiveStores: ${sErr.message}`);

  const issues: ValidationIssue[] = [];
  for (const s of stores ?? []) {
    if (s.id === "PORTFOLIO" || s.id === "__BACKFILL_DEDUPE__") continue;
    // Treat the store as "credentials-present" if EITHER:
    //   (a) creds declared locally (DB row or local env var), OR
    //   (b) the cron has written any daily_orders row recently (= the
    //       production runtime has working creds the validator can't see).
    // This avoids cross-environment false positives — e.g. validator
    // running in a context where local env doesn't have SOLEN_TOKEN even
    // though production Vercel does.
    // DB-only credential resolution (env-var fallback was removed in the
    // Jun 2026 migration — see src/lib/shopify/stores.ts).
    const hasDbCreds =
      !!s.shopify_domain &&
      (!!s.shopify_token_encrypted || !!s.shopify_client_id);
    let credsPresent = hasDbCreds;
    if (!credsPresent) {
      const { data: recentSync } = await sb
        .from("daily_orders")
        .select("synced_at")
        .eq("tenant_id", tenantId)
        .eq("store_id", s.id)
        .gte(
          "synced_at",
          new Date(Date.now() - windowDays * 86400000).toISOString(),
        )
        .limit(1);
      credsPresent = (recentSync ?? []).length > 0;
    }
    if (!credsPresent) continue;

    const { data: orders, error: oErr } = await sb
      .from("daily_orders")
      .select("gross_sales")
      .eq("tenant_id", tenantId)
      .eq("store_id", s.id)
      .gte("date", from);
    if (oErr) throw new Error(`checkInactiveStores: ${oErr.message}`);
    const total = (orders ?? []).reduce(
      (sum, r) => sum + Number(r.gross_sales ?? 0),
      0,
    );
    if (total === 0) {
      issues.push({
        tenant_id: tenantId,
        store_id: s.id,
        date: null,
        check_name: "inactive_store",
        severity: "warn",
        message: `${s.id}: no orders in the last ${windowDays} days — sync broken or store inactive?`,
        details: { window_days: windowDays, total_gross: 0 },
      });
    }
  }
  return issues;
}

/** 2b. Active stores without ANY recent sync activity are a setup
 *  problem — credentials probably missing. We use "has the store ever
 *  been synced in the last N days" as the source of truth instead of
 *  reading env vars directly, because env-var checks give false positives
 *  when production has credentials that the validator process doesn't see
 *  (different runtime, different deployment). The presence of a
 *  daily_orders row written by the cron is hard proof that credentials
 *  exist somewhere that the cron can read. */
export async function checkMissingCredentials(
  tenantId: string,
  windowDays = 14,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const from = isoDaysAgo(windowDays);
  const { data: stores, error } = await sb
    .from("stores")
    .select("id, shopify_domain, shopify_token_encrypted, shopify_client_id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) throw new Error(`checkMissingCredentials: ${error.message}`);

  const issues: ValidationIssue[] = [];
  for (const s of stores ?? []) {
    if (s.id === "PORTFOLIO" || s.id === "__BACKFILL_DEDUPE__") continue;
    // Step 1: declared creds (DB or env) — quick yes if any are present
    // DB-only credential resolution (env-var fallback was removed in the
    // Jun 2026 migration — see src/lib/shopify/stores.ts).
    const hasDbCreds =
      !!s.shopify_domain &&
      (!!s.shopify_token_encrypted || !!s.shopify_client_id);
    if (hasDbCreds) continue;

    // Step 2: no declared creds locally — but is the cron syncing it?
    // A row written within the last N days proves the cron has creds
    // somewhere (production Vercel env). Skip the flag in that case.
    const { data: recentSync } = await sb
      .from("daily_orders")
      .select("synced_at")
      .eq("tenant_id", tenantId)
      .eq("store_id", s.id)
      .gte("synced_at", new Date(Date.now() - windowDays * 86400000).toISOString())
      .limit(1);
    if ((recentSync ?? []).length > 0) continue;

    issues.push({
      tenant_id: tenantId,
      store_id: s.id,
      date: null,
      check_name: "missing_shopify_credentials",
      severity: "warn",
      message: `${s.id}: no Shopify sync activity in ${windowDays} days. Configure credentials: set ${s.id}_DOMAIN + ${s.id}_TOKEN in Vercel env, or in Settings → Integrations.`,
      details: { window_days: windowDays },
    });
  }
  return issues;
}

/** 3. PHX stores should produce subs revenue. If recurring is $0 for a
 *  whole week while there are active subscribers, the Solvpath cron isn't
 *  reaching enough customers. */
export async function checkPhxRecurringMissing(
  tenantId: string,
  windowDays = 7,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const from = isoDaysAgo(windowDays);
  const issues: ValidationIssue[] = [];

  // How many active subscribers per the portfolio snapshot?
  const { data: portfolio } = await sb
    .from("phx_summary_snapshots")
    .select("raw_json")
    .eq("tenant_id", tenantId)
    .eq("store_id", "PORTFOLIO")
    .order("scraped_at", { ascending: false })
    .limit(1);
  const counts = (portfolio?.[0]?.raw_json as
    | { counts?: { Active?: number } }
    | undefined)?.counts;
  const activeSubs = Number(counts?.Active ?? 0);
  if (activeSubs < 100) return issues; // too few to draw a conclusion

  // Look at the last `windowDays` of per-store snapshots and sum recurring.
  const phxStores = ["NOVA", "NURA", "KOVA"];
  for (const store of phxStores) {
    const { data: snaps, error } = await sb
      .from("phx_summary_snapshots")
      .select("revenue_recurring, range_from, range_to")
      .eq("tenant_id", tenantId)
      .eq("store_id", store)
      .gte("range_from", from);
    if (error) throw new Error(`checkPhxRecurringMissing: ${error.message}`);
    const totalRecurring = (snaps ?? []).reduce(
      (sum, r) =>
        sum + (r.range_from === r.range_to ? Number(r.revenue_recurring ?? 0) : 0),
      0,
    );
    if (totalRecurring === 0 && (snaps?.length ?? 0) > 0) {
      issues.push({
        tenant_id: tenantId,
        store_id: store,
        date: null,
        check_name: "phx_recurring_zero",
        severity: "warn",
        message: `${store}: $0 recurring revenue over last ${windowDays} days while ${activeSubs} active subs portfolio-wide — Solvpath cron likely under-sampling customers`,
        details: { active_subs: activeSubs, window_days: windowDays },
      });
    }
  }
  return issues;
}

/** 4. Missing-day check — every active store WITH CREDENTIALS should have
 *  a daily_orders row for every day in the last week (even if all-zero).
 *  A missing row means the sync failed silently. */
export async function checkMissingDays(
  tenantId: string,
  windowDays = 7,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const from = isoDaysAgo(windowDays);
  const to = isoDaysAgo(1); // exclude today (still in progress)
  const dates = listDates(from, to);
  const { data: stores } = await sb
    .from("stores")
    .select("id, shopify_domain, shopify_token_encrypted, shopify_client_id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  // Use synced_at presence as proof-of-credentials — avoids false positives
  // when production has creds the validator process can't see locally.
  const { data: anySynced } = await sb
    .from("daily_orders")
    .select("store_id")
    .eq("tenant_id", tenantId)
    .gte(
      "synced_at",
      new Date(Date.now() - windowDays * 86400000).toISOString(),
    );
  const syncedStoreIds = new Set(
    (anySynced ?? []).map((r) => r.store_id as string),
  );
  const realStores = (stores ?? []).filter((s) => {
    if (s.id === "PORTFOLIO" || s.id === "__BACKFILL_DEDUPE__") return false;
    // DB-only credential resolution (env-var fallback was removed in the
    // Jun 2026 migration — see src/lib/shopify/stores.ts).
    const hasDbCreds =
      !!s.shopify_domain &&
      (!!s.shopify_token_encrypted || !!s.shopify_client_id);
    return hasDbCreds || syncedStoreIds.has(s.id);
  });
  const { data: rows } = await sb
    .from("daily_orders")
    .select("store_id, date")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to);

  const have = new Set(
    (rows ?? []).map((r) => `${r.store_id}|${(r.date as string).slice(0, 10)}`),
  );
  const issues: ValidationIssue[] = [];
  for (const s of realStores) {
    for (const d of dates) {
      if (!have.has(`${s.id}|${d}`)) {
        issues.push({
          tenant_id: tenantId,
          store_id: s.id,
          date: d,
          check_name: "missing_daily_orders",
          severity: "warn",
          message: `${s.id} ${d}: daily_orders row missing — Shopify sync may have failed`,
          details: {},
        });
      }
    }
  }
  return issues;
}

/** 4b. Suspicious zero-streak: a store that had recent revenue and now
 *  shows zero orders for several consecutive days. This catches scenarios
 *  where a Shopify token loses orders-read scope or was revoked — sync
 *  still "succeeds" but returns empty pages, silently writing $0 rows
 *  that look like normal "no orders" days. */
export async function checkSuspiciousZeroStreak(
  tenantId: string,
  recentWindowDays = 14,
  zeroStreakDays = 5,
  pastActivityWindowDays = 60,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const recentFrom = isoDaysAgo(recentWindowDays);
  const pastFrom = isoDaysAgo(pastActivityWindowDays);
  const yesterday = isoDaysAgo(1);

  // List all stores that previously had non-zero days, so we know which
  // ones SHOULD be active.
  const { data: pastActivity, error } = await sb
    .from("daily_orders")
    .select("store_id, date, gross_sales")
    .eq("tenant_id", tenantId)
    .gte("date", pastFrom)
    .lte("date", yesterday)
    .gt("gross_sales", 0);
  if (error) throw new Error(`checkSuspiciousZeroStreak: ${error.message}`);

  const lastActivity = new Map<string, string>();
  for (const r of pastActivity ?? []) {
    const d = String(r.date).slice(0, 10);
    const cur = lastActivity.get(r.store_id as string);
    if (!cur || d > cur) lastActivity.set(r.store_id as string, d);
  }

  // For each store with past activity, check if recent days are all zero.
  const issues: ValidationIssue[] = [];
  for (const [storeId, lastActiveDate] of lastActivity.entries()) {
    if (storeId === "PORTFOLIO" || storeId === "__BACKFILL_DEDUPE__") continue;
    const { data: recent, error: rErr } = await sb
      .from("daily_orders")
      .select("date, gross_sales")
      .eq("tenant_id", tenantId)
      .eq("store_id", storeId)
      .gte("date", recentFrom)
      .lte("date", yesterday)
      .order("date", { ascending: false });
    if (rErr) throw new Error(`checkSuspiciousZeroStreak rows: ${rErr.message}`);
    if (!recent || recent.length === 0) continue;
    // Count leading consecutive zero days from most recent.
    let streak = 0;
    for (const r of recent) {
      if (Number(r.gross_sales) === 0) streak += 1;
      else break;
    }
    if (streak >= zeroStreakDays) {
      issues.push({
        tenant_id: tenantId,
        store_id: storeId,
        date: null,
        check_name: "suspicious_zero_streak",
        severity: "warn",
        message: `${storeId}: ${streak} consecutive zero-order days (last activity ${lastActiveDate}). Token may have lost scope or been revoked — verify Shopify credentials.`,
        details: {
          streak,
          last_active_date: lastActiveDate,
        },
      });
    }
  }
  return issues;
}

/** 5. PHX snapshot gap check — every PHX store (NOVA/NURA/KOVA) should
 *  have a phx_summary_snapshots row for every day. A missing day means
 *  the Solvpath cron failed or skipped that day. */
export async function checkPhxSnapshotGaps(
  tenantId: string,
  windowDays = 14,
): Promise<ValidationIssue[]> {
  const sb = supabaseAdmin();
  const from = isoDaysAgo(windowDays);
  const to = isoDaysAgo(1);
  const dates = listDates(from, to);
  const phxStores = ["NOVA", "NURA", "KOVA"];

  const { data: snaps, error } = await sb
    .from("phx_summary_snapshots")
    .select("store_id, range_from, range_to")
    .eq("tenant_id", tenantId)
    .in("store_id", phxStores)
    .gte("range_from", from)
    .lte("range_to", to);
  if (error) throw new Error(`checkPhxSnapshotGaps: ${error.message}`);

  const have = new Set<string>();
  for (const r of snaps ?? []) {
    const rf = String(r.range_from).slice(0, 10);
    const rt = String(r.range_to).slice(0, 10);
    if (rf === rt) have.add(`${r.store_id}|${rf}`);
  }

  // Skip NURA when it has zero data in the window — it might genuinely
  // have no subscribers rather than a sync gap.
  const phxStoresWithAnyData = phxStores.filter((s) => {
    for (const d of dates) if (have.has(`${s}|${d}`)) return true;
    return false;
  });

  const issues: ValidationIssue[] = [];
  for (const store of phxStoresWithAnyData) {
    for (const d of dates) {
      if (!have.has(`${store}|${d}`)) {
        issues.push({
          tenant_id: tenantId,
          store_id: store,
          date: d,
          check_name: "missing_phx_snapshot",
          severity: "warn",
          message: `${store} ${d}: phx_summary_snapshots row missing — Solvpath cron may have failed for this day. Run scripts/solvpath-full-backfill.mjs to fill it.`,
          details: {},
        });
      }
    }
  }
  return issues;
}

/** Run all checks for a tenant. */
export async function runAllChecks(
  tenantId: string,
): Promise<ValidationIssue[]> {
  const results = await Promise.all([
    checkNegativeNetRevenue(tenantId).catch((e) => [
      issueError(tenantId, "negative_net_revenue", e),
    ]),
    checkInactiveStores(tenantId).catch((e) => [
      issueError(tenantId, "inactive_store", e),
    ]),
    checkMissingCredentials(tenantId).catch((e) => [
      issueError(tenantId, "missing_shopify_credentials", e),
    ]),
    checkPhxRecurringMissing(tenantId).catch((e) => [
      issueError(tenantId, "phx_recurring_zero", e),
    ]),
    checkMissingDays(tenantId).catch((e) => [
      issueError(tenantId, "missing_daily_orders", e),
    ]),
    checkPhxSnapshotGaps(tenantId).catch((e) => [
      issueError(tenantId, "missing_phx_snapshot", e),
    ]),
    checkSuspiciousZeroStreak(tenantId).catch((e) => [
      issueError(tenantId, "suspicious_zero_streak", e),
    ]),
  ]);
  return results.flat();
}

/** Persist issues: re-open existing rows, close issues that didn't recur. */
export async function persistChecks(
  tenantId: string,
  issues: ValidationIssue[],
): Promise<{ inserted: number; closed: number }> {
  const sb = supabaseAdmin();

  // Load currently-open rows to compute the diff.
  const { data: openRows, error: loadErr } = await sb
    .from("data_validation_log")
    .select("id, store_id, date, check_name")
    .eq("tenant_id", tenantId)
    .eq("status", "open");
  if (loadErr) throw new Error(`persistChecks load: ${loadErr.message}`);

  const openKey = (r: {
    store_id: string | null;
    date: string | null;
    check_name: string;
  }) =>
    `${r.store_id ?? ""}|${(r.date as string | null)?.slice(0, 10) ?? ""}|${r.check_name}`;

  const stillOpen = new Set(issues.map(openKey));
  const toClose = (openRows ?? [])
    .filter((r) => !stillOpen.has(openKey(r)))
    .map((r) => r.id);
  const existingKeys = new Set((openRows ?? []).map(openKey));
  const toInsert = issues.filter((i) => !existingKeys.has(openKey(i)));

  if (toClose.length > 0) {
    const { error } = await sb
      .from("data_validation_log")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .in("id", toClose);
    if (error) throw new Error(`persistChecks close: ${error.message}`);
  }
  if (toInsert.length > 0) {
    const { error } = await sb.from("data_validation_log").insert(
      toInsert.map((i) => ({
        tenant_id: i.tenant_id,
        store_id: i.store_id,
        date: i.date,
        check_name: i.check_name,
        severity: i.severity,
        message: i.message,
        details: i.details,
      })),
    );
    if (error) throw new Error(`persistChecks insert: ${error.message}`);
  }
  return { inserted: toInsert.length, closed: toClose.length };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function listDates(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  for (
    let cur = new Date(start);
    cur.getTime() <= end.getTime();
    cur.setUTCDate(cur.getUTCDate() + 1)
  ) {
    out.push(cur.toISOString().slice(0, 10));
  }
  return out;
}

function money(n: unknown): string {
  const x = Number(n);
  return `$${x.toFixed(2)}`;
}

function issueError(
  tenantId: string,
  checkName: string,
  err: unknown,
): ValidationIssue {
  return {
    tenant_id: tenantId,
    store_id: null,
    date: null,
    check_name: checkName,
    severity: "error",
    message: `validator threw: ${(err as Error)?.message ?? err}`,
    details: {},
  };
}

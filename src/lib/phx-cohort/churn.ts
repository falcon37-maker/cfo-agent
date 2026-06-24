// Cohort-based churn engine (Phase 7).
//
// Reads phx_cohort_charges and derives the metrics the CFO churn spec asks for:
//   • cohort retention curve — per signup cohort, % of members still billing
//     (Approved) at each cycle
//   • first-rebill survival   — VIP Initial → Month 1 (the big one-time drop)
//   • steady-state monthly churn — Month 1 → Month 2 (the headline)
//   • voluntary vs involuntary split on the headline step
//
// Signup cohort = the month of a customer's cycle-0 (Vip Initial) charge.
// Active at cycle N = the cohort has an Approved charge at cycle N.
//
// Mature-cohort rule: a cohort has only "reached" cycle N+1 once enough calendar
// time has passed that its cycle-(N+1) billing date is in the past. We require
// (N+1) whole months between the cohort month and today before counting that
// cohort toward the cycle-(N+1) figure — otherwise young cohorts deflate the
// next-cycle count and churn reads artificially high (the spec's ~48% vs ~31%).

import { supabaseAdmin } from "@/lib/supabase/admin";

export type CohortRow = {
  cohort: string; // "YYYY-MM" of signup (cycle-0 month)
  size: number; // distinct customers acquired in the cohort (cycle-0 approved)
  active: number[]; // active[N] = distinct customers Approved at cycle N
};

export type ChurnSummary = {
  // Headline steady-state monthly churn (Month 1 → Month 2), cohort-weighted.
  monthlyChurnPct: number | null;
  retentionPct: number | null; // 1 − churn
  // First rebill (VIP Initial → Month 1) survival, cohort-weighted.
  firstRebillSurvivalPct: number | null;
  firstRebillChurnPct: number | null;
  // Voluntary vs involuntary split on the headline (M1 → M2) step.
  voluntaryPct: number | null; // cancelled before/at M2 billing
  involuntaryPct: number | null; // declined at M2
  // The cohort retention curve (matrix) behind everything.
  cohorts: CohortRow[];
  // Echo of the totals used for the headline (for display / sanity).
  headline: {
    activeM1: number;
    activeM2: number;
    declinedM2: number; // involuntary losses between M1 and M2
    voluntaryM2: number; // voluntary losses (derived)
  } | null;
  asOf: string;
};

type Charge = {
  customer_id: number;
  cycle: number;
  status: string; // approved | declined
  txn_date: string;
};

/** YYYY-MM of a date string. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Whole months between two YYYY-MM strings (b − a). */
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/**
 * Build the cohort retention matrix + churn summary for a tenant.
 * `maxCycle` caps the curve width (default 6 cycles).
 */
export async function computeCohortChurn(
  tenantId: string,
  opts?: { maxCycle?: number; asOf?: string; storeIds?: string[] },
): Promise<ChurnSummary> {
  const maxCycle = opts?.maxCycle ?? 6;
  const asOf = opts?.asOf ?? new Date().toISOString().slice(0, 10);
  const asOfMonth = monthOf(asOf);
  const sb = supabaseAdmin();

  // Pull all charges (paginated — wide windows exceed the 1000-row cap).
  const charges: Charge[] = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    let q = sb
      .from("phx_cohort_charges")
      .select("customer_id, cycle, status, txn_date")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);
    if (opts?.storeIds && opts.storeIds.length) {
      q = q.in("store_id", opts.storeIds);
    }
    const { data } = await q;
    if (!data || data.length === 0) break;
    charges.push(...(data as Charge[]));
    if (data.length < PAGE) break;
  }

  // 1) Assign each customer to a signup cohort = month of their cycle-0 charge.
  //    A customer with no cycle-0 row in our window can't be cohort-anchored.
  const cohortOf = new Map<number, string>();
  for (const c of charges) {
    if (c.cycle === 0 && c.status === "approved") {
      const m = monthOf(c.txn_date);
      const existing = cohortOf.get(c.customer_id);
      // Earliest cycle-0 month wins (their true acquisition month).
      if (!existing || m < existing) cohortOf.set(c.customer_id, m);
    }
  }

  // 2) Per cohort, the set of customers Approved at each cycle (distinct).
  //    activeSets[cohort][cycle] = Set<customer_id>
  const activeSets = new Map<string, Map<number, Set<number>>>();
  // Declines at each cycle per cohort (for the involuntary split).
  const declineSets = new Map<string, Map<number, Set<number>>>();

  const ensure = (
    map: Map<string, Map<number, Set<number>>>,
    cohort: string,
    cycle: number,
  ): Set<number> => {
    let byCycle = map.get(cohort);
    if (!byCycle) {
      byCycle = new Map();
      map.set(cohort, byCycle);
    }
    let set = byCycle.get(cycle);
    if (!set) {
      set = new Set();
      byCycle.set(cycle, set);
    }
    return set;
  };

  for (const c of charges) {
    const cohort = cohortOf.get(c.customer_id);
    if (!cohort) continue;
    if (c.cycle > maxCycle) continue;
    if (c.status === "approved") {
      ensure(activeSets, cohort, c.cycle).add(c.customer_id);
    } else if (c.status === "declined") {
      ensure(declineSets, cohort, c.cycle).add(c.customer_id);
    }
  }

  // 3) Build the cohort rows (retention curve).
  const cohorts: CohortRow[] = [];
  for (const [cohort, byCycle] of [...activeSets.entries()].sort()) {
    const size = byCycle.get(0)?.size ?? 0;
    if (size === 0) continue;
    const active: number[] = [];
    for (let n = 0; n <= maxCycle; n++) active.push(byCycle.get(n)?.size ?? 0);
    cohorts.push({ cohort, size, active });
  }

  // 4) Cohort-weighted transition churn(N → N+1), mature cohorts only.
  //    A cohort counts toward cycle N+1 only if (N+1) whole months have elapsed
  //    since its signup month (its cycle-(N+1) billing date is in the past).
  const weightedChurn = (n: number): { from: number; to: number } | null => {
    let from = 0;
    let to = 0;
    for (const c of cohorts) {
      const age = monthsBetween(c.cohort, asOfMonth);
      if (age < n + 1) continue; // not mature enough to have reached N+1
      from += c.active[n] ?? 0;
      to += c.active[n + 1] ?? 0;
    }
    return from > 0 ? { from, to } : null;
  };

  // Headline: M1 → M2 steady-state.
  const m1m2 = weightedChurn(1);
  // First rebill: VIP(0) → M1.
  const m0m1 = weightedChurn(0);

  // Voluntary vs involuntary on the M1 → M2 step. Involuntary = customers who
  // were active at M1 and had a DECLINE at M2 (within mature cohorts). The rest
  // of the M1→M2 loss is treated as voluntary (cancelled before/at M2 billing).
  let involuntaryM2 = 0;
  if (m1m2) {
    for (const c of cohorts) {
      const age = monthsBetween(c.cohort, asOfMonth);
      if (age < 2) continue;
      const decl = declineSets.get(c.cohort)?.get(2);
      const activeM1 = activeSets.get(c.cohort)?.get(1);
      const activeM2 = activeSets.get(c.cohort)?.get(2);
      if (!decl || !activeM1) continue;
      // Involuntary loss = was paying at M1, got declined at M2, and did NOT
      // recover (no Approved M2 charge — e.g. salvage). A decline that later
      // salvages isn't churn, so exclude anyone still in the M2-active set.
      for (const cust of decl) {
        if (activeM1.has(cust) && !activeM2?.has(cust)) involuntaryM2++;
      }
    }
  }

  const round1 = (n: number) => Math.round(n * 1000) / 10; // → 1-decimal %

  const monthlyChurnPct = m1m2 ? round1(1 - m1m2.to / m1m2.from) : null;
  const retentionPct = m1m2 ? round1(m1m2.to / m1m2.from) : null;
  const firstRebillSurvivalPct = m0m1 ? round1(m0m1.to / m0m1.from) : null;
  const firstRebillChurnPct = m0m1 ? round1(1 - m0m1.to / m0m1.from) : null;

  let voluntaryPct: number | null = null;
  let involuntaryPct: number | null = null;
  let headline: ChurnSummary["headline"] = null;
  if (m1m2) {
    const totalLost = m1m2.from - m1m2.to;
    const voluntaryM2 = Math.max(0, totalLost - involuntaryM2);
    involuntaryPct = round1(involuntaryM2 / m1m2.from);
    voluntaryPct = round1(voluntaryM2 / m1m2.from);
    headline = {
      activeM1: m1m2.from,
      activeM2: m1m2.to,
      declinedM2: involuntaryM2,
      voluntaryM2,
    };
  }

  return {
    monthlyChurnPct,
    retentionPct,
    firstRebillSurvivalPct,
    firstRebillChurnPct,
    voluntaryPct,
    involuntaryPct,
    cohorts,
    headline,
    asOf,
  };
}

// /churn — cohort-based churn (Phase 7).
//
// The subscription-health view the client spec asks for:
//   • Monthly churn % headline (Month 1 → Month 2, steady-state)
//   • First-rebill (VIP → Month 1) survival, shown separately
//   • Voluntary vs involuntary split
//   • Cohort retention curve — the ground truth behind everything
//
// All derived from phx_cohort_charges via computeCohortChurn (mature cohorts
// only, so young cohorts don't deflate the next-cycle count).

import {
  TrendingDown,
  Repeat,
  UserMinus,
  CreditCard,
  Layers,
} from "lucide-react";
import { requireTenant } from "@/lib/tenant";
import { computeCohortChurn } from "@/lib/phx-cohort/churn";
import { CohortRetentionTable } from "@/components/churn/CohortRetentionTable";
import { ChurnStoreFilter } from "@/components/churn/ChurnStoreFilter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Churn — CFO Agent" };

const PHX_STORES = ["KOVA", "NOVA", "NURA"];

function pct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

type ChurnCardProps = {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  tone?: "danger" | "good" | "neutral";
};

function ChurnCard({ label, value, sub, icon, tone = "neutral" }: ChurnCardProps) {
  return (
    <div className="churn-card" data-tone={tone}>
      <div className="churn-card-head">
        <span className="churn-card-label">{label}</span>
        <span className="churn-card-icon">{icon}</span>
      </div>
      <div className="churn-card-value">{value}</div>
      <div className="churn-card-sub">{sub}</div>
    </div>
  );
}

export default async function ChurnPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const sp = await searchParams;
  const tenant = await requireTenant();

  const selectedStore =
    sp.store && PHX_STORES.includes(sp.store.toUpperCase())
      ? sp.store.toUpperCase()
      : null;

  const churn = await computeCohortChurn(tenant.id, {
    maxCycle: 6,
    storeIds: selectedStore ? [selectedStore] : undefined,
  });

  const hasData = churn.cohorts.length > 0;

  return (
    <div className="page">
      <div className="page-head churn-head">
        <div>
          <h1 className="page-title">Churn</h1>
          <p className="page-sub">
            Cohort-based subscription churn · mature cohorts only · Phoenix
            billing history
          </p>
        </div>
        <ChurnStoreFilter stores={PHX_STORES} selected={selectedStore} />
      </div>

      {!hasData ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ color: "var(--muted)" }}>
            No cohort data for this view yet.
          </p>
        </div>
      ) : (
        <>
          <section className="churn-cards">
            <ChurnCard
              label="Monthly Churn"
              value={pct(churn.monthlyChurnPct)}
              sub="M1 → M2 · steady-state"
              icon={<TrendingDown size={15} />}
              tone="danger"
            />
            <ChurnCard
              label="Monthly Retention"
              value={pct(churn.retentionPct)}
              sub="still paying month-over-month"
              icon={<Repeat size={15} />}
              tone="good"
            />
            <ChurnCard
              label="First Rebill Drop"
              value={pct(churn.firstRebillChurnPct)}
              sub="VIP → M1 · one-time"
              icon={<TrendingDown size={15} />}
            />
            <ChurnCard
              label="Voluntary"
              value={pct(churn.voluntaryPct)}
              sub="customer cancelled"
              icon={<UserMinus size={15} />}
            />
            <ChurnCard
              label="Involuntary"
              value={pct(churn.involuntaryPct)}
              sub="card declined"
              icon={<CreditCard size={15} />}
            />
          </section>

          <div className="card churn-section">
            <div className="churn-section-head">
              <div>
                <div className="card-title">Steady-state monthly churn</div>
                <div className="card-sub">
                  Month 1 → Month 2 (cohort-weighted, mature cohorts only). The
                  first rebill (VIP → M1) is a one-time impulse drop, reported
                  separately above.
                </div>
              </div>
            </div>
            {churn.headline ? (
              <div className="churn-flow">
                <FlowStat
                  value={churn.headline.activeM1.toLocaleString()}
                  label="Paying at Month 1"
                />
                <FlowArrow />
                <FlowStat
                  value={churn.headline.activeM2.toLocaleString()}
                  label="Still paying at Month 2"
                  tone="pos"
                />
                <FlowSplit>
                  <FlowStat
                    value={churn.headline.voluntaryM2.toLocaleString()}
                    label="Cancelled"
                    tone="neg"
                    small
                  />
                  <FlowStat
                    value={churn.headline.declinedM2.toLocaleString()}
                    label="Declined"
                    tone="neg"
                    small
                  />
                </FlowSplit>
              </div>
            ) : null}
          </div>

          <div className="card churn-section">
            <div className="churn-section-head">
              <div>
                <div className="card-title">
                  <Layers
                    size={15}
                    style={{ verticalAlign: "-2px", marginRight: 6 }}
                  />
                  Cohort retention curve
                </div>
                <div className="card-sub">
                  Each signup cohort’s % still billing by cycle — the ground
                  truth behind every number above. Dotted cells are cohorts too
                  young to have reached that cycle.
                </div>
              </div>
            </div>
            <CohortRetentionTable cohorts={churn.cohorts} maxCycle={6} />
          </div>
        </>
      )}
    </div>
  );
}

function FlowStat({
  value,
  label,
  tone,
  small,
}: {
  value: string;
  label: string;
  tone?: "pos" | "neg";
  small?: boolean;
}) {
  return (
    <div className={`churn-flow-stat ${small ? "small" : ""}`}>
      <div className="churn-flow-value" data-tone={tone}>
        {value}
      </div>
      <div className="churn-flow-label">{label}</div>
    </div>
  );
}

function FlowArrow() {
  return <div className="churn-flow-arrow">→</div>;
}

function FlowSplit({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="churn-flow-arrow">↘</div>
      <div className="churn-flow-split">{children}</div>
    </>
  );
}

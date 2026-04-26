import { loadStores } from "@/lib/pnl/queries";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

// All edits are no-op in Phase A — these read from (and only from) stores.processing_fee_pct
// for the fee rate; other thresholds are placeholder values until a `rules` table exists.
export default async function RulesSettingsPage() {
  const tenant = await requireTenant();
  const stores = await loadStores(tenant.id);
  // Surface the first store's fee rate — in practice they should all be the same.
  const feePct = stores[0]?.processing_fee_pct ?? 0.1;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Financial rates</div>
            <div className="card-sub">Applied when computing daily P&amp;L</div>
          </div>
        </div>
        <div>
          <RuleRow
            label="Processing fee rate"
            desc="Shopify + payment processor fees as a % of gross sales."
          >
            <div className="rule-input">
              <span className="val">{(feePct * 100).toFixed(1)}</span>
              <span className="rule-affix">%</span>
            </div>
          </RuleRow>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Alert thresholds</div>
            <div className="card-sub">Placeholder values — editable once the rules table lands</div>
          </div>
        </div>
        <div>
          <RuleRow
            label="ROAS floor"
            desc="Flag campaigns below this ROAS for the day."
          >
            <div className="rule-input">
              <span className="val">1.5</span>
              <span className="rule-affix">x</span>
            </div>
          </RuleRow>
          <RuleRow
            label="Net margin floor"
            desc="Flag days when consolidated net margin drops below this level."
          >
            <div className="rule-input">
              <span className="val">20</span>
              <span className="rule-affix">%</span>
            </div>
          </RuleRow>
          <RuleRow
            label="Cash warning"
            desc="Alert when projected cash crosses below this number."
          >
            <div className="rule-input">
              <span className="rule-affix">$</span>
              <span className="val">100,000</span>
            </div>
          </RuleRow>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Agent autonomy</div>
            <div className="card-sub">Let the agent take corrective actions without asking</div>
          </div>
        </div>
        <div>
          <RuleRow
            label="Auto-pause underperforming campaigns"
            desc="Pause ad sets below the ROAS floor for 2+ consecutive days."
          >
            <div className="toggle" aria-checked={false} role="switch">
              <div className="toggle-dot" />
            </div>
          </RuleRow>
          <RuleRow
            label="Auto-retry subscription charges"
            desc="Retry failed charges up to 3 times on a 1/3/7-day cadence."
          >
            <div className="toggle" aria-checked={false} role="switch">
              <div className="toggle-dot" />
            </div>
          </RuleRow>
        </div>
      </div>
    </>
  );
}

function RuleRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rule-row">
      <div className="rule-body">
        <div className="rule-label">{label}</div>
        <div className="rule-desc">{desc}</div>
      </div>
      {children}
    </div>
  );
}

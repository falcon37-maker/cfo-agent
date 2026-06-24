-- Phoenix cohort charges (Phase 7 — Churn engine, Jun 2026).
--
-- Cohort-based churn needs per-customer, per-cycle billing history — NOT the
-- daily aggregates in phx_summary_snapshots. We store one row per Phoenix
-- billing charge with enough to assign each customer to a signup cohort and
-- bucket their charges by cycle number:
--
--   • customer_id   — from the bulk get_details "Customer" field ("123 - A - B")
--   • cycle         — parsed from Type: "Vip Initial" = 0, "N Month" = N
--   • status        — approved | declined  (Capture/Direct Sale & !Failed vs
--                     a failed/declined rebill attempt)
--   • txn_date      — the charge date (store-local YYYY-MM-DD)
--
-- The churn engine derives, per signup cohort, how many members are still
-- successfully billing at each cycle, and the cohort retention curve from that.
-- Source: Phoenix portal bulk API (transactions/get_details), capture-aware.

CREATE TABLE IF NOT EXISTS phx_cohort_charges (
  id            bigserial    PRIMARY KEY,
  tenant_id     uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Phoenix identity
  customer_id   bigint       NOT NULL,           -- parsed from "Customer" field
  order_id      bigint       NULL,               -- Phoenix OrderId (unique per charge)
  store_id      text         NULL,               -- NOVA / NURA / KOVA (domain-mapped)
  -- Cohort + cycle
  cycle         integer      NOT NULL,           -- 0 = Vip Initial, N = N Month
  charge_type   text         NULL,               -- raw Type string ("Vip Initial", "3 Month"…)
  is_upsell     boolean      NOT NULL DEFAULT false,
  -- Outcome
  status        text         NOT NULL,           -- 'approved' | 'declined'
  amount        numeric(12,2) NOT NULL DEFAULT 0,
  -- Timing
  txn_date      date         NOT NULL,           -- store-local YYYY-MM-DD of the charge
  charged_at    timestamptz  NULL,
  raw_type      text         NULL,               -- TransactionType (Capture/Pre-Auth/…)
  synced_at     timestamptz  NOT NULL DEFAULT now(),
  -- One row per Phoenix charge. OrderId is unique per transaction in Phoenix;
  -- fall back to (customer, cycle, txn_date) handled at the app layer when an
  -- OrderId is missing.
  CONSTRAINT phx_cohort_charge_unique UNIQUE (tenant_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_phx_cohort_customer
  ON phx_cohort_charges (tenant_id, customer_id, cycle);
CREATE INDEX IF NOT EXISTS idx_phx_cohort_date
  ON phx_cohort_charges (tenant_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_phx_cohort_cycle
  ON phx_cohort_charges (tenant_id, cycle, status);

ALTER TABLE phx_cohort_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "phx_cohort_tenant_isolation" ON phx_cohort_charges;
CREATE POLICY "phx_cohort_tenant_isolation" ON phx_cohort_charges
  FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid() LIMIT 1));

COMMENT ON TABLE phx_cohort_charges IS
  'Per-customer per-cycle Phoenix billing charges. Powers cohort-based churn '
  '(Phase 7): signup cohort = month of cycle-0 charge; retention curve = '
  'approved count by cycle within each cohort.';

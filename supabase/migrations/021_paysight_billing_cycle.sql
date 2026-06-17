-- 021: Billing-cycle fields on paysight_transactions.
--
-- Client clarified (Jun 2026): the P&L "Subs Rev" column must show only
-- subscription revenue BILLED that day (rebills), not newly-acquired checkout
-- orders. Paysight's Admin API (/api/transactions/search) exposes the fields
-- needed to tell them apart; the Mitigation API we previously synced from
-- does not:
--
--   paymentNumber  — billing cycle. 0 = initial checkout order (newly
--                    acquired), >= 1 = recurring rebill (billed from subs)
--   attempt        — billing attempt (1 = natural, 2+ = retries/salvage)
--   subId          — owning subscription id (0 = none)
--   storeName      — Paysight's own store label (KOVA / NURA / NOVA USA),
--                    more reliable than descriptor-regex mapping
--
-- Additive only — no existing data is modified. Rows synced before this
-- migration have NULLs until the next re-sync populates them.

ALTER TABLE paysight_transactions
  ADD COLUMN IF NOT EXISTS payment_number integer,
  ADD COLUMN IF NOT EXISTS attempt integer,
  ADD COLUMN IF NOT EXISTS sub_id bigint,
  ADD COLUMN IF NOT EXISTS store_name text;

-- The billed-revenue read path filters on (tenant, date, payment_number).
CREATE INDEX IF NOT EXISTS paysight_txn_billed_idx
  ON paysight_transactions (tenant_id, txn_date)
  WHERE payment_number >= 1;

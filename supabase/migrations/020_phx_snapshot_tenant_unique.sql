-- 020: Make phx_summary_snapshots unique per TENANT.
--
-- Bug: the unique constraint was (store_id, range_from, range_to) — tenant
-- agnostic. With multiple active tenants all syncing the same global Phoenix
-- PORTFOLIO snapshot, each tenant's per-day upsert collided on the shared key,
-- so the LAST tenant in the cron loop overwrote the row (incl. its tenant_id).
-- Dashboard reads filter by tenant_id, so the real client (Falcon 37) would
-- then read a stale older-day row while today's data sat under a test tenant.
--
-- Fix: the snapshot is logically per-tenant — include tenant_id in the unique
-- key so every tenant keeps its own row and upserts no longer race.

ALTER TABLE phx_summary_snapshots
  DROP CONSTRAINT IF EXISTS phx_summary_snapshots_store_range_unique;

-- Defensive: collapse any pre-existing exact duplicates on the NEW key before
-- adding the constraint (keep the most recently scraped row per group).
DELETE FROM phx_summary_snapshots a
USING phx_summary_snapshots b
WHERE a.tenant_id = b.tenant_id
  AND a.store_id   = b.store_id
  AND a.range_from = b.range_from
  AND a.range_to   = b.range_to
  AND a.scraped_at < b.scraped_at;

ALTER TABLE phx_summary_snapshots
  ADD CONSTRAINT phx_summary_snapshots_tenant_store_range_unique
  UNIQUE (tenant_id, store_id, range_from, range_to);

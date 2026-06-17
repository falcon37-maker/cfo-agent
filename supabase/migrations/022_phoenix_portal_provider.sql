-- Allow 'phoenix_portal' as an integrations provider.
--
-- The Phoenix portal bulk-transactions API (get_details) is authenticated with
-- a rotating refresh_token stored in integrations(provider='phoenix_portal').
-- The original CHECK constraint (migration 014) only allowed the three legacy
-- providers, so seeding the token failed. Widen the constraint.

-- Safety: this ONLY widens an allowed-values rule. It does not touch any row,
-- column, or data. The new list is a strict SUPERSET of the old one (all old
-- providers stay valid), so no existing row can ever violate it. Wrapped in a
-- transaction by the runner — if the ADD fails, the DROP rolls back too, so
-- the table is never left without its guard.
ALTER TABLE integrations
  DROP CONSTRAINT IF EXISTS integrations_provider_check;

ALTER TABLE integrations
  ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('chargeblast', 'solvpath', 'zoho_books', 'phoenix_portal'));

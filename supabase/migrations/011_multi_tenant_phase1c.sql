-- Multi-tenant phase 1C: signup trigger + RLS.
--
-- Phase 1A built the schema. Phase 1B threaded tenant_id through every
-- read/write. This migration:
--   1. Backfills any existing auth.users that don't have a tenant yet
--      (e.g. the manager email that signed up before phase 1A landed).
--   2. Adds an after-insert trigger on auth.users so future signups get
--      a tenant row provisioned automatically.
--   3. Enables RLS on every data table with a "tenant_isolation" policy.
--
-- Cron jobs and server actions still use the service-role key, which
-- bypasses RLS — so behavior doesn't change for the existing app paths.
-- RLS is defense-in-depth: any future query that uses the user's anon-key
-- client (e.g. an embedded widget, an external integration) will be
-- automatically scoped to their tenant.

-- ── 1. backfill any auth.users that pre-date phase 1A ─────────────────────
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN SELECT id, email FROM auth.users LOOP
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE user_id = rec.id) THEN
      PERFORM ensure_owner_tenant(rec.id, rec.email, NULL);
    END IF;
  END LOOP;
END $$;

-- ── 2. signup trigger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user_create_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM ensure_owner_tenant(NEW.id, NEW.email, NULL);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_create_tenant();

-- ── 3. RLS on tenants table ───────────────────────────────────────────────
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_self_read" ON tenants;
CREATE POLICY "tenant_self_read" ON tenants
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "tenant_self_update" ON tenants;
CREATE POLICY "tenant_self_update" ON tenants
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── 4. RLS on every data table — same shape, different table name ────────
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'stores',
    'daily_pnl',
    'daily_orders',
    'daily_ad_spend',
    'cogs_entries',
    'ad_spend_entries',
    'zoho_credentials',
    'phx_summary_snapshots',
    'chargeblast_alerts'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "tenant_isolation" ON %I FOR ALL USING (tenant_id = (SELECT id FROM tenants WHERE user_id = auth.uid())) WITH CHECK (tenant_id = (SELECT id FROM tenants WHERE user_id = auth.uid()))',
      t
    );
  END LOOP;
END $$;

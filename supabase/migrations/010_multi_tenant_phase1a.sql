-- Multi-tenant phase 1A: structural foundation only.
--
-- Adds the tenants table + tenant_id on every data table, seeds Joseph as
-- the first tenant, and backfills all existing rows. RLS is NOT enabled
-- here — that's phase 1C. Cron + queries still use the service role key,
-- so this migration is a no-op for runtime behavior.

-- ── 1. tenants table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  email        TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  is_active    BOOLEAN DEFAULT TRUE,
  settings     JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_tenants_user_id ON tenants(user_id);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(is_active);

-- ── 2. seed Joseph's tenant ────────────────────────────────────────────────
-- Look up by email to avoid hardcoding user_id (which differs between dev /
-- prod). If Joseph isn't in auth.users yet (fresh dev DB), the migration
-- skips the seed cleanly — phase 1C's signup trigger will create his tenant
-- on first login instead.
DO $$
DECLARE
  joseph_user_id UUID;
  joseph_tenant_id UUID;
BEGIN
  SELECT id INTO joseph_user_id
  FROM auth.users
  WHERE email = 'josephgomezco@gmail.com'
  LIMIT 1;

  IF joseph_user_id IS NULL THEN
    RAISE NOTICE 'No auth.users row for josephgomezco@gmail.com — skipping seed; backfill will run when phase 1C provisions the tenant.';
    RETURN;
  END IF;

  -- Idempotent insert.
  INSERT INTO tenants (user_id, display_name, email)
  VALUES (joseph_user_id, 'Falcon 37 LLC', 'josephgomezco@gmail.com')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id INTO joseph_tenant_id
  FROM tenants
  WHERE user_id = joseph_user_id;

  -- Stash for the backfill block below — temporarily store on a session
  -- variable that's only used inside this migration.
  PERFORM set_config('cfoagent.bootstrap_tenant_id', joseph_tenant_id::TEXT, FALSE);
END $$;

-- ── 3. add tenant_id to every data table (NULLable for now) ────────────────
ALTER TABLE stores                 ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE daily_pnl              ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE daily_orders           ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE daily_ad_spend         ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE cogs_entries           ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE ad_spend_entries       ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE zoho_credentials       ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE phx_summary_snapshots  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE chargeblast_alerts     ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

-- ── 4. backfill every existing row to Joseph's tenant ──────────────────────
DO $$
DECLARE
  bootstrap_tenant_id UUID;
BEGIN
  bootstrap_tenant_id := NULLIF(current_setting('cfoagent.bootstrap_tenant_id', TRUE), '')::UUID;

  IF bootstrap_tenant_id IS NULL THEN
    RAISE NOTICE 'No bootstrap tenant id found — skipping backfill. Existing rows keep tenant_id NULL until a tenant is provisioned.';
    RETURN;
  END IF;

  UPDATE stores                 SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE daily_pnl              SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE daily_orders           SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE daily_ad_spend         SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE cogs_entries           SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE ad_spend_entries       SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE zoho_credentials       SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE phx_summary_snapshots  SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
  UPDATE chargeblast_alerts     SET tenant_id = bootstrap_tenant_id WHERE tenant_id IS NULL;
END $$;

-- ── 5. set NOT NULL — but only when the table has no remaining NULLs ──────
-- The conditional check keeps the migration replayable on a fresh DB where
-- the seed couldn't find Joseph in auth.users. In that case, NOT NULL is
-- deferred until phase 1C creates the tenant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stores WHERE tenant_id IS NULL) THEN
    ALTER TABLE stores ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM daily_pnl WHERE tenant_id IS NULL) THEN
    ALTER TABLE daily_pnl ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM daily_orders WHERE tenant_id IS NULL) THEN
    ALTER TABLE daily_orders ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM daily_ad_spend WHERE tenant_id IS NULL) THEN
    ALTER TABLE daily_ad_spend ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cogs_entries WHERE tenant_id IS NULL) THEN
    ALTER TABLE cogs_entries ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ad_spend_entries WHERE tenant_id IS NULL) THEN
    ALTER TABLE ad_spend_entries ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM zoho_credentials WHERE tenant_id IS NULL) THEN
    ALTER TABLE zoho_credentials ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM phx_summary_snapshots WHERE tenant_id IS NULL) THEN
    ALTER TABLE phx_summary_snapshots ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chargeblast_alerts WHERE tenant_id IS NULL) THEN
    ALTER TABLE chargeblast_alerts ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
END $$;

-- ── 6. tenant_id indexes per table ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_stores_tenant                 ON stores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_daily_pnl_tenant              ON daily_pnl(tenant_id);
CREATE INDEX IF NOT EXISTS idx_daily_orders_tenant           ON daily_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_daily_ad_spend_tenant         ON daily_ad_spend(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cogs_entries_tenant           ON cogs_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ad_spend_entries_tenant       ON ad_spend_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_zoho_credentials_tenant       ON zoho_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_phx_summary_snapshots_tenant  ON phx_summary_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chargeblast_alerts_tenant     ON chargeblast_alerts(tenant_id);

-- ── 7. ensure_owner_tenant() — used by phase 1C to provision tenants on
--      sign-up. Defined here so phase 1A leaves the DB in a fully wired
--      state and phase 1C just attaches it to a trigger. Idempotent.
CREATE OR REPLACE FUNCTION ensure_owner_tenant(
  p_user_id UUID,
  p_email   TEXT,
  p_display TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  out_id UUID;
BEGIN
  INSERT INTO tenants (user_id, display_name, email)
  VALUES (p_user_id, COALESCE(p_display, split_part(p_email, '@', 1)), p_email)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING id INTO out_id;

  IF out_id IS NULL THEN
    SELECT id INTO out_id FROM tenants WHERE user_id = p_user_id;
  END IF;
  RETURN out_id;
END $$;

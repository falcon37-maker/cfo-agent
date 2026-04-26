-- Multi-tenant phase 1D.4: tenant_memberships.
--
-- Replaces the stopgap fallback in src/lib/tenant.ts that auto-routed
-- manager-role users to the earliest active tenant. Memberships make the
-- relationship explicit: any user can belong to any tenant with a role.
-- The trigger from migration 011 still creates a tenant per signup
-- (i.e. owners get their own tenant); members get added by an admin via
-- Settings (lands in a follow-up).
--
-- Also adds a solvpath_store_code column to stores so per-tenant Solvpath
-- store mapping doesn't have to live in code (currently hardcoded
-- 1059/1045/1058 → NOVA/NURA/KOVA in src/lib/solvpath/sync.ts).

-- ── 1. tenant_memberships table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_memberships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'viewer')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user
  ON tenant_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant
  ON tenant_memberships(tenant_id);

-- ── 2. backfill memberships from existing tenants ────────────────────────
-- Every existing tenants.user_id becomes an 'owner' membership.
INSERT INTO tenant_memberships (tenant_id, user_id, role)
SELECT id, user_id, 'owner' FROM tenants
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- The manager email shares Joseph's tenant for now. This replaces the
-- runtime fallback in src/lib/tenant.ts.
DO $$
DECLARE
  joseph_tenant_id UUID;
  manager_user_id UUID;
BEGIN
  SELECT t.id INTO joseph_tenant_id
  FROM tenants t
  WHERE t.email = 'josephgomezco@gmail.com'
  LIMIT 1;

  SELECT id INTO manager_user_id
  FROM auth.users
  WHERE email = 'manager@shoppingecom.com'
  LIMIT 1;

  IF joseph_tenant_id IS NOT NULL AND manager_user_id IS NOT NULL THEN
    INSERT INTO tenant_memberships (tenant_id, user_id, role)
    VALUES (joseph_tenant_id, manager_user_id, 'manager')
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  END IF;
END $$;

-- ── 3. RLS on tenant_memberships ─────────────────────────────────────────
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "membership_self_read" ON tenant_memberships;
CREATE POLICY "membership_self_read" ON tenant_memberships
  FOR SELECT USING (user_id = auth.uid());

-- ── 4. solvpath_store_code on stores ─────────────────────────────────────
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS solvpath_store_code INTEGER;

UPDATE stores SET solvpath_store_code = 1059 WHERE id = 'NOVA' AND solvpath_store_code IS NULL;
UPDATE stores SET solvpath_store_code = 1045 WHERE id = 'NURA' AND solvpath_store_code IS NULL;
UPDATE stores SET solvpath_store_code = 1058 WHERE id = 'KOVA' AND solvpath_store_code IS NULL;

-- Multi-tenant phase 2: schema for self-serve onboarding.
--
--  - integrations: per-tenant API keys for Chargeblast / Solvpath / Zoho,
--    replacing the global env vars (which stay as fallback for backward
--    compat with Joseph's existing setup).
--  - pending_invitations: lets an admin invite a teammate by email before
--    that person has an auth.users row; a trigger consumes the row on
--    signup and creates the membership automatically.
--  - manual_revenue_entries: free-form revenue logging for non-API
--    sources (coaching, consulting, etc.) that don't come from Shopify
--    or Solvpath.
--
-- Each table gets RLS scoped to the current tenant. Cron + server-side
-- code continues to use the service-role key and bypasses RLS by design.

-- ── integrations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('chargeblast', 'solvpath', 'zoho_books')),
  -- Encrypted credentials shaped per-provider:
  --   chargeblast: { apiKey, webhookSecret? }
  --   solvpath:    { partnerId, partnerToken, bearerToken, baseUrl? }
  --   zoho_books:  { orgId } (access/refresh tokens stay in zoho_credentials)
  credentials     JSONB DEFAULT '{}'::jsonb,
  is_active       BOOLEAN DEFAULT TRUE,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integrations_tenant ON integrations(tenant_id);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON integrations;
CREATE POLICY "tenant_isolation" ON integrations
  FOR ALL
  USING (tenant_id = (SELECT id FROM tenants WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT id FROM tenants WHERE user_id = auth.uid()));

-- ── pending_invitations ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
  invited_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_pending_invitations_email ON pending_invitations(lower(email));
CREATE INDEX IF NOT EXISTS idx_pending_invitations_tenant ON pending_invitations(tenant_id);

ALTER TABLE pending_invitations ENABLE ROW LEVEL SECURITY;

-- Admins of the inviting tenant can read/write their own pending invites.
DROP POLICY IF EXISTS "tenant_isolation" ON pending_invitations;
CREATE POLICY "tenant_isolation" ON pending_invitations
  FOR ALL
  USING (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id = auth.uid()));

-- ── manual_revenue_entries ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_revenue_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  store_id      TEXT,    -- nullable; "General" entries don't attach to a store
  date          DATE NOT NULL,
  revenue_type  TEXT NOT NULL,
  description   TEXT,
  amount        NUMERIC(12, 2) NOT NULL,
  notes         TEXT,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manual_revenue_tenant_date
  ON manual_revenue_entries(tenant_id, date DESC);

ALTER TABLE manual_revenue_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON manual_revenue_entries;
CREATE POLICY "tenant_isolation" ON manual_revenue_entries
  FOR ALL
  USING (tenant_id = (SELECT id FROM tenants WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT id FROM tenants WHERE user_id = auth.uid()));

-- ── stores: add a couple of fields the Phase 2 UI will write ───────────
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS processing_fee_fixed NUMERIC(8, 4),
  ADD COLUMN IF NOT EXISTS store_type TEXT
    DEFAULT 'shopify' CHECK (store_type IN ('shopify', 'manual'));

-- ── update signup trigger to consume pending_invitations ───────────────
-- When a user signs up with an email that has a pending invite, attach
-- them to that tenant via tenant_memberships and delete the invitation.
-- The earlier ensure_owner_tenant() call in handle_new_user_create_tenant
-- runs first, so the user always has their own owner-tenant; the
-- membership rows here ADD shared access into the inviter's tenant(s).
CREATE OR REPLACE FUNCTION public.handle_new_user_create_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Provision the user's own tenant (idempotent).
  PERFORM ensure_owner_tenant(NEW.id, NEW.email, NULL);

  -- Consume any pending invitations for this email and create
  -- corresponding tenant_memberships rows. Multiple invites are allowed;
  -- each becomes a separate membership.
  INSERT INTO tenant_memberships (tenant_id, user_id, role)
    SELECT pi.tenant_id, NEW.id, pi.role
    FROM pending_invitations pi
    WHERE lower(pi.email) = lower(NEW.email)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  DELETE FROM pending_invitations
    WHERE lower(email) = lower(NEW.email);

  RETURN NEW;
END $$;

-- Trigger already exists from migration 011; no need to drop/recreate
-- since CREATE OR REPLACE updated the body.

-- ── seed Joseph's existing integrations from env-equivalent values ─────
-- We can't read process.env from SQL, so the actual encrypted credential
-- payload is left empty here — the backend will fall back to env vars
-- until the Settings UI writes real DB-stored values. This row just
-- marks the integration as present so cron can prefer it when the JSONB
-- has real content. Encrypted via app-level AES once the Settings UI is
-- used to (re-)save credentials.
DO $$
DECLARE
  joseph_tenant_id UUID;
BEGIN
  SELECT id INTO joseph_tenant_id
  FROM tenants
  WHERE email = 'josephgomezco@gmail.com'
  LIMIT 1;

  IF joseph_tenant_id IS NOT NULL THEN
    INSERT INTO integrations (tenant_id, provider, credentials, is_active)
    VALUES
      (joseph_tenant_id, 'chargeblast', '{}'::jsonb, TRUE),
      (joseph_tenant_id, 'solvpath',    '{}'::jsonb, TRUE),
      (joseph_tenant_id, 'zoho_books',  '{}'::jsonb, TRUE)
    ON CONFLICT (tenant_id, provider) DO NOTHING;
  END IF;
END $$;

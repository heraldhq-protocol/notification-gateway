-- Design Partner Billing Tier Grant
-- Adds billing_type, granted_tier, and tier_grant_expires_at to support free tier grants
-- as an alternative to paid retainers. Idempotent — safe to re-run.

ALTER TABLE design_partners
  ADD COLUMN IF NOT EXISTS billing_type           VARCHAR(20)   NOT NULL DEFAULT 'retainer',
  ADD COLUMN IF NOT EXISTS granted_tier           SMALLINT,
  ADD COLUMN IF NOT EXISTS tier_grant_expires_at  TIMESTAMPTZ;

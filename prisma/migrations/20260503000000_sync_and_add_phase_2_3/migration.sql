-- Migration: sync_and_add_phase_2_3
-- Brings migration history in line with actual DB state (which was managed via db:push)
-- and documents Phase 2 + Phase 3 admin features added in May 2026.

-- ─────────────────────────────────────────────────────────────────────────────
-- DRIFT FIXES — changes db:push applied that weren't in migration files
-- ─────────────────────────────────────────────────────────────────────────────

-- NOTE: sandbox_receipts table and sandbox api_key columns (is_test_key,
-- expires_at, test_daily_limit, test_key_type, test_key_ip_hash,
-- test_notifications_sent) are intentionally KEPT because the notification
-- gateway service still reads and writes these columns. Dropping them here
-- would break gateway sandbox functionality.

-- Rename asset_type column in protocol_assets (was mapped inconsistently)
-- Only run if old column exists and new doesn't
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='protocol_assets' AND column_name='asset_type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='protocol_assets' AND column_name='assetType') THEN
    ALTER TABLE "protocol_assets" RENAME COLUMN "asset_type" TO "assetType";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 — Protocol admin notes
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "protocols"
  ADD COLUMN IF NOT EXISTS "admin_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "overage_enabled" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 — Notification receipt tracking
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "receipt_failure_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "last_receipt_attempt_at" TIMESTAMPTZ(6);

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 — Incident: make monitor_id nullable, add affected_component
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "incidents"
  ALTER COLUMN "monitor_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "affected_component" VARCHAR(255);

-- Update FK to use SET NULL on delete
ALTER TABLE "incidents" DROP CONSTRAINT IF EXISTS "incidents_monitor_id_fkey";
ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_monitor_id_fkey"
  FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 — Incident timeline
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "incident_timelines" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "incident_id" UUID NOT NULL,
  "message"     TEXT NOT NULL,
  "author"      VARCHAR(100) NOT NULL DEFAULT 'herald-admin',
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "incident_timelines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_incident_timeline_incident"
  ON "incident_timelines"("incident_id", "created_at");

ALTER TABLE "incident_timelines" DROP CONSTRAINT IF EXISTS "incident_timelines_incident_id_fkey";
ALTER TABLE "incident_timelines"
  ADD CONSTRAINT "incident_timelines_incident_id_fkey"
  FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 — Notification templates (if not already created by db:push)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notification_templates" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "protocol_id"      UUID NOT NULL,
  "name"             VARCHAR(100) NOT NULL,
  "category"         VARCHAR(20) NOT NULL,
  "subject_template" TEXT,
  "html_source"      TEXT,
  "text_source"      TEXT,
  "preview_text"     VARCHAR(200),
  "herald_footer"    VARCHAR(20) NOT NULL DEFAULT 'full',
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "is_default"       BOOLEAN NOT NULL DEFAULT false,
  "version"          INTEGER NOT NULL DEFAULT 1,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_notif_templates_protocol"
  ON "notification_templates"("protocol_id", "category");

ALTER TABLE "notification_templates" DROP CONSTRAINT IF EXISTS "notification_templates_protocol_id_fkey";
ALTER TABLE "notification_templates"
  ADD CONSTRAINT "notification_templates_protocol_id_fkey"
  FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS "notification_template_versions" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "template_id"      UUID NOT NULL,
  "version"          INTEGER NOT NULL DEFAULT 1,
  "html_source"      TEXT NOT NULL,
  "subject_template" TEXT,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "notification_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_template_version"
  ON "notification_template_versions"("template_id", "version");

CREATE INDEX IF NOT EXISTS "idx_template_versions_template"
  ON "notification_template_versions"("template_id");

ALTER TABLE "notification_template_versions" DROP CONSTRAINT IF EXISTS "notification_template_versions_template_id_fkey";
ALTER TABLE "notification_template_versions"
  ADD CONSTRAINT "notification_template_versions_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 3 — Herald internal admin users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "admin_users" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "display_name"      VARCHAR(100) NOT NULL,
  "role"              VARCHAR(20) NOT NULL DEFAULT 'viewer',
  "auth_method"       VARCHAR(20) NOT NULL,
  "wallet_pubkey_hash" VARCHAR(64),
  "email_hash"        VARCHAR(64),
  "email_encrypted"   BYTEA,
  "password_hash"     VARCHAR(100),
  "totp_enabled"      BOOLEAN NOT NULL DEFAULT false,
  "totp_secret"       VARCHAR(64),
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "last_active_at"    TIMESTAMPTZ(6),
  "invited_by"        UUID,
  "invite_token"      VARCHAR(100),
  "invite_expires_at" TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_invite_token_key"
  ON "admin_users"("invite_token");

CREATE INDEX IF NOT EXISTS "idx_admin_users_wallet"
  ON "admin_users"("wallet_pubkey_hash");

CREATE INDEX IF NOT EXISTS "idx_admin_users_email"
  ON "admin_users"("email_hash");

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 3 — Design partners
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "design_partners" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "protocol_id"           UUID NOT NULL,
  "retainer_amount_cents" INTEGER NOT NULL DEFAULT 100000,
  "retainer_start"        TIMESTAMPTZ(6) NOT NULL,
  "retainer_end"          TIMESTAMPTZ(6),
  "status"                VARCHAR(20) NOT NULL DEFAULT 'active',
  "feedback_sessions"     INTEGER NOT NULL DEFAULT 0,
  "equity_warrant_issued" BOOLEAN NOT NULL DEFAULT false,
  "notes"                 TEXT,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "design_partners_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "design_partners_protocol_id_key"
  ON "design_partners"("protocol_id");

CREATE INDEX IF NOT EXISTS "idx_design_partners_status"
  ON "design_partners"("status");

ALTER TABLE "design_partners" DROP CONSTRAINT IF EXISTS "design_partners_protocol_id_fkey";
ALTER TABLE "design_partners"
  ADD CONSTRAINT "design_partners_protocol_id_fkey"
  FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE;

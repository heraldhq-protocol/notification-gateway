-- Repair: columns and tables that were baselined without running.
-- All statements are idempotent (IF NOT EXISTS / IF EXISTS guards).
-- This migration is safe to run on any DB state.

BEGIN;

-- ── api_keys sandbox columns ─────────────────────────────────────────────────
-- Originally in 20260419194422 but that migration was baselined on first deploy.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at"              TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "is_test_key"             BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "test_daily_limit"        SMALLINT      NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "test_notifications_sent" SMALLINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "test_key_type"           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "test_key_ip_hash"        VARCHAR(64);

CREATE INDEX IF NOT EXISTS "idx_api_keys_test_key"
  ON "api_keys" ("is_test_key", "created_at");

-- ── sandbox_receipts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sandbox_receipts" (
  "id"              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_key_id"      UUID          NOT NULL,
  "notification_id" UUID,
  "wallet_hash"     VARCHAR(64)   NOT NULL,
  "subject"         VARCHAR(200),
  "status"          VARCHAR(20)   NOT NULL DEFAULT 'delivered',
  "devnet_tx"       VARCHAR(88),
  "channel"         VARCHAR(20),
  "delivered_at"    TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_sandbox_receipts_api_key"
  ON "sandbox_receipts" ("api_key_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_sandbox_receipts_created"
  ON "sandbox_receipts" ("created_at");

-- FK: sandbox_receipts -> api_keys
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'sandbox_receipts_api_key_id_fkey'
  ) THEN
    ALTER TABLE "sandbox_receipts"
      ADD CONSTRAINT "sandbox_receipts_api_key_id_fkey"
      FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── channel_deliveries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "channel_deliveries" (
  "id"              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "notification_id" UUID          NOT NULL,
  "channel"         VARCHAR(20)   NOT NULL,
  "success"         BOOLEAN       NOT NULL DEFAULT false,
  "message_id"      VARCHAR(200),
  "provider"        VARCHAR(30),
  "error"           TEXT,
  "delivered_at"    TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_channel_del_notification"
  ON "channel_deliveries" ("notification_id");

CREATE INDEX IF NOT EXISTS "idx_channel_del_channel"
  ON "channel_deliveries" ("channel", "success");

-- FK: channel_deliveries -> notifications
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'channel_deliveries_notification_id_fkey'
  ) THEN
    ALTER TABLE "channel_deliveries"
      ADD CONSTRAINT "channel_deliveries_notification_id_fkey"
      FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── notification_templates ───────────────────────────────────────────────────
-- Originally in 20260420160000 (and in admin-api 20260503000000) — idempotent.
CREATE TABLE IF NOT EXISTS "notification_templates" (
  "id"               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "protocol_id"      UUID          NOT NULL,
  "name"             VARCHAR(100)  NOT NULL,
  "category"         VARCHAR(20)   NOT NULL,
  "subject_template" TEXT,
  "html_source"      TEXT,
  "text_source"      TEXT,
  "preview_text"     VARCHAR(200),
  "herald_footer"    VARCHAR(20)   NOT NULL DEFAULT 'full',
  "is_active"        BOOLEAN       NOT NULL DEFAULT true,
  "is_default"       BOOLEAN       NOT NULL DEFAULT false,
  "version"          INT           NOT NULL DEFAULT 1,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_notif_templates_protocol"
  ON "notification_templates" ("protocol_id", "category");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'notification_templates_protocol_id_fkey'
  ) THEN
    ALTER TABLE "notification_templates"
      ADD CONSTRAINT "notification_templates_protocol_id_fkey"
      FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── notification_template_versions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notification_template_versions" (
  "id"               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id"      UUID          NOT NULL,
  "version"          INT           NOT NULL DEFAULT 1,
  "html_source"      TEXT          NOT NULL,
  "subject_template" TEXT,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_template_version"
  ON "notification_template_versions" ("template_id", "version");

CREATE INDEX IF NOT EXISTS "idx_template_versions_template"
  ON "notification_template_versions" ("template_id");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'notification_template_versions_template_id_fkey'
  ) THEN
    ALTER TABLE "notification_template_versions"
      ADD CONSTRAINT "notification_template_versions_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ── telegram_templates ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "telegram_templates" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "protocol_id" UUID         NOT NULL,
  "name"        VARCHAR(100) NOT NULL,
  "category"    VARCHAR(20)  NOT NULL,
  "text_template" TEXT       NOT NULL,
  "buttons"     JSONB,
  "is_active"   BOOLEAN      NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_telegram_templates_protocol"
  ON "telegram_templates" ("protocol_id", "category");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'telegram_templates_protocol_id_fkey'
  ) THEN
    ALTER TABLE "telegram_templates"
      ADD CONSTRAINT "telegram_templates_protocol_id_fkey"
      FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;

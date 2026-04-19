-- Migration: add_sandbox_api_key_fields_and_receipts
-- Adds sandbox test key columns to api_keys and creates sandbox_receipts table.
-- These fields support hrld_test_xxxx API keys (sandbox environment).

-- ── ApiKey sandbox columns ───────────────────────────────────────────────────

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at"             TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "is_test_key"            BOOLEAN        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "test_daily_limit"       SMALLINT       NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "test_notifications_sent" SMALLINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "test_key_type"          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "test_key_ip_hash"       VARCHAR(64);

-- Index for efficient daily cleanup / analytics queries on test keys
CREATE INDEX IF NOT EXISTS "idx_api_keys_test_key"
  ON "api_keys" ("is_test_key", "created_at");

-- ── SandboxReceipt table ─────────────────────────────────────────────────────

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

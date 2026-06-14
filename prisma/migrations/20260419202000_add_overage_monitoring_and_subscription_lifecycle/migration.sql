-- Migration: add_overage_monitoring_and_subscription_lifecycle
-- Adds: OverageLedger, OverageInvoice tables; monitors/checks/incidents (IF NOT EXISTS);
-- extends Subscription with lifecycle + overage fields;
-- extends ProtocolSettings with overage control fields.

-- ── Enums (PostgreSQL CREATE TYPE IF NOT EXISTS requires DO block) ────────────

DO $$ BEGIN
  CREATE TYPE "MonitorStatus" AS ENUM ('up', 'down', 'degraded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentStatus" AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentSeverity" AS ENUM ('critical', 'major', 'minor', 'maintenance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Monitors (IF NOT EXISTS — may have been created via db push) ──────────────

CREATE TABLE IF NOT EXISTS "monitors" (
  "id"                   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                 VARCHAR(255)    NOT NULL,
  "url"                  VARCHAR(255)    NOT NULL,
  "interval"             INT             NOT NULL DEFAULT 60,
  "timeout"              INT             NOT NULL DEFAULT 5000,
  "is_active"            BOOLEAN         NOT NULL DEFAULT true,
  "current_status"       "MonitorStatus" NOT NULL DEFAULT 'up',
  "uptime_percentage"    DECIMAL(5,2)    NOT NULL DEFAULT 0,
  "average_response_time" INT            NOT NULL DEFAULT 0,
  "created_at"           TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6)  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "checks" (
  "id"            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "monitor_id"    UUID            NOT NULL REFERENCES "monitors"("id") ON DELETE CASCADE,
  "status"        "MonitorStatus" NOT NULL,
  "response_time" INT             NOT NULL,
  "status_code"   INT,
  "error_message" TEXT,
  "created_at"    TIMESTAMPTZ(6)  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_checks_monitor_date"
  ON "checks" ("monitor_id", "created_at");

CREATE TABLE IF NOT EXISTS "incidents" (
  "id"          UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  "monitor_id"  UUID               NOT NULL REFERENCES "monitors"("id") ON DELETE CASCADE,
  "title"       VARCHAR(255)       NOT NULL,
  "description" TEXT               NOT NULL,
  "status"      "IncidentStatus"   NOT NULL DEFAULT 'investigating',
  "severity"    "IncidentSeverity" NOT NULL,
  "started_at"  TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6)     NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ(6)     NOT NULL DEFAULT now()
);

-- ── OverageInvoice (referenced by OverageLedger) ──────────────────────────────

CREATE TABLE IF NOT EXISTS "overage_invoices" (
  "id"                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  "protocol_id"         UUID           NOT NULL REFERENCES "protocols"("id"),
  "period_start"        TIMESTAMPTZ(6) NOT NULL,
  "period_end"          TIMESTAMPTZ(6) NOT NULL,
  "total_overages"      BIGINT         NOT NULL,
  "total_usdc"          BIGINT         NOT NULL,
  "channel_breakdown"   JSONB          NOT NULL DEFAULT '{}',
  "status"              VARCHAR(20)    NOT NULL DEFAULT 'pending',
  "collection_method"   VARCHAR(20),
  "helio_payment_link"  TEXT,
  "helio_transaction_id" VARCHAR(100)  UNIQUE,
  "solana_tx_signature" VARCHAR(88),
  "issued_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "due_at"              TIMESTAMPTZ(6) NOT NULL,
  "paid_at"             TIMESTAMPTZ(6),
  "failed_at"           TIMESTAMPTZ(6),
  "failure_reason"      TEXT
);

CREATE INDEX IF NOT EXISTS "idx_overage_inv_protocol"
  ON "overage_invoices" ("protocol_id", "period_start");

-- ── OverageLedger ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "overage_ledger" (
  "id"              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  "protocol_id"     UUID           NOT NULL REFERENCES "protocols"("id"),
  "notification_id" UUID,
  "channel"         VARCHAR(20)    NOT NULL DEFAULT 'email',
  "tier_at_send"    SMALLINT       NOT NULL,
  "price_usdc"      BIGINT         NOT NULL,
  "period_start"    TIMESTAMPTZ(6) NOT NULL,
  "period_end"      TIMESTAMPTZ(6) NOT NULL,
  "settled"         BOOLEAN        NOT NULL DEFAULT false,
  "invoice_id"      UUID           REFERENCES "overage_invoices"("id"),
  "sent_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_overage_protocol_period"
  ON "overage_ledger" ("protocol_id", "period_start", "settled");

-- ── Subscription — subscription lifecycle + overage fields ───────────────────

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "grace_period_days"       INT            NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "grace_period_started_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "grace_period_ends_at"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "renewal_due_date"        TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_reminder_sent"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "next_charge_url"         TEXT,
  ADD COLUMN IF NOT EXISTS "charge_token"            TEXT,
  ADD COLUMN IF NOT EXISTS "ended_at"                TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "end_reason"              TEXT,
  ADD COLUMN IF NOT EXISTS "is_anonymous"            BOOLEAN        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "overages_this_period"    BIGINT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "overage_usdc_this_period" BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "overage_hard_cap_hit"    BOOLEAN        NOT NULL DEFAULT false;

-- ── ProtocolSettings — overage controls ─────────────────────────────────────

ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "opt_in_overage"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "max_overage_usdc"        BIGINT  NOT NULL DEFAULT 500000000,
  ADD COLUMN IF NOT EXISTS "overage_alert_at_usdc"   BIGINT  NOT NULL DEFAULT 50000000,
  ADD COLUMN IF NOT EXISTS "overage_hard_cap_enabled" BOOLEAN NOT NULL DEFAULT true;

-- ── api_keys — sandbox columns (in case notification-gateway migration not yet applied) ─

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at"              TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "is_test_key"             BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "test_daily_limit"        SMALLINT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "test_notifications_sent" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "test_key_type"           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "test_key_ip_hash"        VARCHAR(64);

CREATE INDEX IF NOT EXISTS "idx_api_keys_test_key"
  ON "api_keys" ("is_test_key", "created_at");

-- ── sandbox_receipts (shared table used by notification-gateway) ─────────────

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

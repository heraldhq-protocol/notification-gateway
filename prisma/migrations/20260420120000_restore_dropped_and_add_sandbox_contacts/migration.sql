-- Migration: restore_dropped_and_add_sandbox_contacts
-- Restores monitors, checks, incidents tables and overage columns that were
-- dropped by an accidental `prisma db push --accept-data-loss` on the gateway.
-- Also adds sandbox test contact fields to protocol_settings.

-- ── Enums (idempotent) ───────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "MonitorStatus" AS ENUM ('up', 'down', 'degraded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentStatus" AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentSeverity" AS ENUM ('critical', 'major', 'minor', 'maintenance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Restore monitors ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "monitors" (
  "id"                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                  VARCHAR(255)    NOT NULL,
  "url"                   VARCHAR(255)    NOT NULL,
  "interval"              INT             NOT NULL DEFAULT 60,
  "timeout"               INT             NOT NULL DEFAULT 5000,
  "is_active"             BOOLEAN         NOT NULL DEFAULT true,
  "current_status"        "MonitorStatus" NOT NULL DEFAULT 'up',
  "uptime_percentage"     DECIMAL(5,2)    NOT NULL DEFAULT 0,
  "average_response_time" INT             NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6)  NOT NULL DEFAULT now()
);

-- ── Restore checks ───────────────────────────────────────────────────────────

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

-- ── Restore incidents ────────────────────────────────────────────────────────

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

-- ── Restore protocol_settings overage columns ────────────────────────────────

ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "opt_in_overage"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "max_overage_usdc"         BIGINT  NOT NULL DEFAULT 500000000,
  ADD COLUMN IF NOT EXISTS "overage_alert_at_usdc"    BIGINT  NOT NULL DEFAULT 50000000,
  ADD COLUMN IF NOT EXISTS "overage_hard_cap_enabled"  BOOLEAN NOT NULL DEFAULT true;

-- ── Add sandbox test contact fields ─────────────────────────────────────────

ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "test_email"        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "test_telegram_id"  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "test_phone"        VARCHAR(30);

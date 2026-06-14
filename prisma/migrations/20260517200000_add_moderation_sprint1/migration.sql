-- Sprint 1 — Admin Moderation Queue
-- Adds: FLAGGED verification status, strike system, ModerationQueue table, TemplateStatus

-- ── 1. Create VerificationStatus enum if missing, then add FLAGGED ─────────────
DO $$ BEGIN
  CREATE TYPE "VerificationStatus" AS ENUM (
    'UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'FLAGGED'
  );
EXCEPTION
  WHEN duplicate_object THEN
    -- enum already exists, just add FLAGGED if not present
    BEGIN
      ALTER TYPE "VerificationStatus" ADD VALUE IF NOT EXISTS 'FLAGGED';
    EXCEPTION WHEN others THEN NULL;
    END;
END $$;

-- Add verification_status column to protocols if missing
ALTER TABLE "protocols"
  ADD COLUMN IF NOT EXISTS "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "protocols"
  ADD COLUMN IF NOT EXISTS "verified_at"       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verification_note" TEXT;

-- ── 2. New enums ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ModerationItemType" AS ENUM (
    'protocol_registration',
    'content_scan',
    'health_degradation',
    'user_report'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ModerationSeverity" AS ENUM (
    'low', 'medium', 'high', 'critical'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TemplateStatus" AS ENUM (
    'DRAFT', 'APPROVED', 'PENDING_REVIEW', 'REJECTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Strike system columns on protocols ──────────────────────────────────────
ALTER TABLE "protocols"
  ADD COLUMN IF NOT EXISTS "strike_count"        SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "strikes_reset_at"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_strike_at"      TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "strike_reasons"      JSONB,
  ADD COLUMN IF NOT EXISTS "registration_flags"  JSONB;

-- ── 4. ModerationQueue table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "moderation_queue" (
  "id"             UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "protocol_id"    UUID                 NOT NULL,
  "type"           "ModerationItemType" NOT NULL,
  "severity"       "ModerationSeverity" NOT NULL DEFAULT 'medium',
  "flag_reason"    TEXT                 NOT NULL,
  "ai_scan_result" JSONB,
  "rules_triggers" TEXT[]               NOT NULL DEFAULT '{}',
  "resolved_at"    TIMESTAMPTZ(6),
  "resolved_by"    VARCHAR(100),
  "resolution"     VARCHAR(30),
  "created_at"     TIMESTAMPTZ(6)       NOT NULL DEFAULT NOW(),
  CONSTRAINT "moderation_queue_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "moderation_queue"
    ADD CONSTRAINT "moderation_queue_protocol_id_fkey"
    FOREIGN KEY ("protocol_id")
    REFERENCES "protocols"("id")
    ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_modq_protocol"
  ON "moderation_queue"("protocol_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_modq_resolved"
  ON "moderation_queue"("resolved_at");

-- ── 5. TemplateStatus on notification_templates ────────────────────────────────
ALTER TABLE "notification_templates"
  ADD COLUMN IF NOT EXISTS "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT';

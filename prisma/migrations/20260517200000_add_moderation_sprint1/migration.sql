-- Sprint 1 — Sync moderation schema fields to gateway
-- The moderation_queue table is managed by admin-api; gateway only needs
-- the shared Protocol columns and TemplateStatus enum for enforcement.

-- ── 1. New enum: TemplateStatus ────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "TemplateStatus" AS ENUM (
    'DRAFT',
    'APPROVED',
    'PENDING_REVIEW',
    'REJECTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Strike fields on Protocol (written by admin-api, read by gateway) ───────
ALTER TABLE "protocols"
  ADD COLUMN IF NOT EXISTS "strike_count"       SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "strikes_reset_at"   TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_strike_at"     TIMESTAMPTZ(6);

-- ── 3. TemplateStatus on notification_templates ────────────────────────────────
ALTER TABLE "notification_templates"
  ADD COLUMN IF NOT EXISTS "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT';

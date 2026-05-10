-- EmailSuppression model
-- Adds table for tracking suppressed emails (bounces, complaints, etc.)
-- Created: 2026-05-10

BEGIN;

CREATE TABLE IF NOT EXISTS "email_suppressions" (
    "wallet_hash" VARCHAR(64) PRIMARY KEY,
    "reason" VARCHAR(20) NOT NULL,
    "suppressed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "notification_id" UUID,
    "auto_suppressed" BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "email_suppressions_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

COMMIT;

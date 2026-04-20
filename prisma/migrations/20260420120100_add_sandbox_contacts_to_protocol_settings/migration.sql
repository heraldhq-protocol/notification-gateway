-- Migration: add_sandbox_contacts_to_protocol_settings
-- Adds test_email, test_telegram_id, test_phone to protocol_settings.
-- These fields already exist in the DB (applied by admin API migration),
-- so all statements are idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "test_email"       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "test_telegram_id" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "test_phone"       VARCHAR(30);

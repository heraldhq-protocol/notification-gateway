-- Add onboarding checklist + quiet hours fields to portal_users
ALTER TABLE "portal_users"
  ADD COLUMN "first_decrypted"   BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN "quiet_hours_start" SMALLINT,
  ADD COLUMN "quiet_hours_end"   SMALLINT,
  ADD COLUMN "quiet_hours_tz"    VARCHAR(64),
  ADD COLUMN "snooze_until"      TIMESTAMPTZ(6);

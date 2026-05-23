-- Replaces original migration which conflicted with admin-api's 20260517130000_add_campaigns.
-- audiences, campaigns, and CampaignStatus already exist from the admin-api migration.
-- This migration only creates the gateway-exclusive pieces.

DO $$ BEGIN
  CREATE TYPE "ScheduleType" AS ENUM ('ONE_TIME', 'RECURRING');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ScheduledJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "scheduled_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "protocol_id" UUID NOT NULL,
    "wallet" VARCHAR(44),
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "category" VARCHAR(30) NOT NULL DEFAULT 'defi',
    "channels" TEXT[] NOT NULL DEFAULT ARRAY['email']::TEXT[],
    "schedule_type" "ScheduleType" NOT NULL DEFAULT 'ONE_TIME',
    "cron_expr" VARCHAR(100),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'UTC',
    "next_run_at" TIMESTAMPTZ(6) NOT NULL,
    "last_run_at" TIMESTAMPTZ(6),
    "status" "ScheduledJobStatus" NOT NULL DEFAULT 'PENDING',
    "template_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "scheduled_notifications_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "scheduled_notifications"
    ADD CONSTRAINT "scheduled_notifications_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "idx_scheduled_notifications_protocol"
  ON "scheduled_notifications"("protocol_id", "status", "next_run_at");

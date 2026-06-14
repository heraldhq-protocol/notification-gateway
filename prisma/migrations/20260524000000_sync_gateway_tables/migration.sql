-- Sync tables owned by herald-notification-gateway into the shared DB.
-- Safe to re-run — all statements use IF NOT EXISTS or exception guards.

-- Enums (gateway-exclusive)
DO $$ BEGIN
  CREATE TYPE "ScheduleType" AS ENUM ('ONE_TIME', 'RECURRING');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ScheduledJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- notification_engagements
CREATE TABLE IF NOT EXISTS "notification_engagements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "notification_id" UUID NOT NULL,
  "protocol_id" UUID NOT NULL,
  "event_type" VARCHAR(20) NOT NULL,
  "link_url" VARCHAR(2000),
  "user_agent_hash" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "notification_engagements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_eng_notification" ON "notification_engagements"("notification_id");
CREATE INDEX IF NOT EXISTS "idx_eng_protocol_type" ON "notification_engagements"("protocol_id", "event_type");

-- protocol_subscriptions
CREATE TABLE IF NOT EXISTS "protocol_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_pubkey" VARCHAR(44),
  "wallet_hash" VARCHAR(64) NOT NULL,
  "protocol_id" UUID NOT NULL,
  "channels" TEXT[] NOT NULL DEFAULT ARRAY['email'::TEXT],
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "source" VARCHAR(30) NOT NULL DEFAULT 'join_link',
  "subscribed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "protocol_subscriptions_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
  ALTER TABLE "protocol_subscriptions"
    ADD CONSTRAINT "protocol_subscriptions_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "protocol_subscriptions_wallet_hash_protocol_id_key"
  ON "protocol_subscriptions"("wallet_hash", "protocol_id");
CREATE INDEX IF NOT EXISTS "idx_protocol_subscriptions_protocol_status"
  ON "protocol_subscriptions"("protocol_id", "status");
CREATE INDEX IF NOT EXISTS "idx_protocol_subscriptions_wallet"
  ON "protocol_subscriptions"("wallet_hash");

-- scheduled_notifications
CREATE TABLE IF NOT EXISTS "scheduled_notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "protocol_id" UUID NOT NULL,
  "wallet" VARCHAR(44),
  "subject" VARCHAR(200) NOT NULL,
  "body" TEXT NOT NULL,
  "category" VARCHAR(30) NOT NULL DEFAULT 'defi',
  "channels" TEXT[] NOT NULL DEFAULT ARRAY['email'::TEXT],
  "schedule_type" "ScheduleType" NOT NULL DEFAULT 'ONE_TIME',
  "cron_expr" VARCHAR(100),
  "timezone" VARCHAR(50) NOT NULL DEFAULT 'UTC',
  "next_run_at" TIMESTAMPTZ(6) NOT NULL,
  "last_run_at" TIMESTAMPTZ(6),
  "status" "ScheduledJobStatus" NOT NULL DEFAULT 'PENDING',
  "template_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduled_notifications_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
  ALTER TABLE "scheduled_notifications"
    ADD CONSTRAINT "scheduled_notifications_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE INDEX IF NOT EXISTS "idx_scheduled_notifications_protocol"
  ON "scheduled_notifications"("protocol_id", "status", "next_run_at");

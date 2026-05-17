-- Sprint 3: notification engagement tracking table
-- Applied via prisma db push (shadow DB unavailable in dev)

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

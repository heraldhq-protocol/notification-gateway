-- Sprint 3: retry policy fields on protocol_settings, marketplace_templates table
-- Applied via prisma db push (shadow DB unavailable in dev)

ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "retry_max_attempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "retry_window_hours" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS "retry_backoff" VARCHAR(20) NOT NULL DEFAULT 'exponential',
  ADD COLUMN IF NOT EXISTS "critical_categories" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "track_engagement" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "marketplace_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" VARCHAR(120) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "category" VARCHAR(60) NOT NULL DEFAULT 'general',
  "use_case_tag" VARCHAR(80) NOT NULL DEFAULT '',
  "email_html" TEXT,
  "email_subject" VARCHAR(255),
  "sms_text" TEXT,
  "telegram_text" TEXT,
  "variables" JSONB NOT NULL DEFAULT '[]',
  "preview_image_url" VARCHAR(500),
  "is_official" BOOLEAN NOT NULL DEFAULT false,
  "usage_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "marketplace_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_templates_slug_key" ON "marketplace_templates"("slug");

-- NotificationTemplate schema
-- Created: 2026-04-20

BEGIN;

-- notification_templates table
CREATE TABLE IF NOT EXISTS "notification_templates" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "protocol_id" UUID NOT NULL REFERENCES "protocols"("id") ON DELETE CASCADE,
    "name" VARCHAR(100) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "subject_template" TEXT,
    "html_source" TEXT,
    "text_source" TEXT,
    "preview_text" VARCHAR(200),
    "herald_footer" VARCHAR(20) NOT NULL DEFAULT 'full',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_notif_templates_protocol" ON "notification_templates" ("protocol_id", "category");

-- notification_template_versions table
CREATE TABLE IF NOT EXISTS "notification_template_versions" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL REFERENCES "notification_templates"("id") ON DELETE CASCADE,
    "version" INT NOT NULL DEFAULT 1,
    "html_source" TEXT NOT NULL,
    "subject_template" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_template_version" ON "notification_template_versions" ("template_id", "version");
CREATE INDEX IF NOT EXISTS "idx_template_versions_template" ON "notification_template_versions" ("template_id");

-- telegram_templates table (if not exists)
CREATE TABLE IF NOT EXISTS "telegram_templates" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "protocol_id" UUID NOT NULL REFERENCES "protocols"("id") ON DELETE CASCADE,
    "name" VARCHAR(100) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "text_template" TEXT NOT NULL,
    "buttons" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_telegram_templates_protocol" ON "telegram_templates" ("protocol_id", "category");

COMMIT;
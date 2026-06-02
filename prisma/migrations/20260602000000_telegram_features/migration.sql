ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "telegram_bot_name"           VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "telegram_auto_pin_enabled"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "telegram_welcome_message"    VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "telegram_group_member_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "telegram_member_count_at"    TIMESTAMPTZ(6);

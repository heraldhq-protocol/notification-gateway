-- Add topic thread routing to protocol_settings.
-- Stores a JSON map of category -> message_thread_id for Telegram forum supergroups.
-- e.g. {"defi": "123456", "governance": "789012"}
ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "telegram_thread_ids" JSONB;

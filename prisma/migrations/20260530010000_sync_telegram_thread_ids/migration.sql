-- Sync: add topic thread routing to protocol_settings (matches gateway migration 20260530010000).
ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "telegram_thread_ids" JSONB;

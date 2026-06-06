-- AlterTable
ALTER TABLE "protocol_settings"
  ADD COLUMN "telegram_migration_sent_at" TIMESTAMPTZ(6);

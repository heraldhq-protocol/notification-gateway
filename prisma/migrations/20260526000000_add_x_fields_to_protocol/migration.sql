-- AlterTable: add X/Twitter OAuth fields to protocols
ALTER TABLE "protocols"
  ADD COLUMN "x_user_id"      VARCHAR(64)   UNIQUE,
  ADD COLUMN "x_username"     VARCHAR(64),
  ADD COLUMN "x_verified"     BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN "x_connected_at" TIMESTAMPTZ(6);

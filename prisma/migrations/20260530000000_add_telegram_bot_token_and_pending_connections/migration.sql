-- AddColumns: custom telegram bot token + group chat ID on protocol_settings
-- AddTable: telegram_pending_connections for /start wallet-link flow

ALTER TABLE "protocol_settings"
  ADD COLUMN IF NOT EXISTS "telegram_bot_token_encrypted" BYTEA,
  ADD COLUMN IF NOT EXISTS "telegram_bot_username"        VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "telegram_group_chat_id"       VARCHAR(30);

CREATE TABLE IF NOT EXISTS "telegram_pending_connections" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "wallet_pubkey"    VARCHAR(44)  NOT NULL,
  "chat_id"          VARCHAR(30)  NOT NULL,
  "telegram_username" VARCHAR(50),
  "claimed"          BOOLEAN      NOT NULL DEFAULT false,
  "expires_at"       TIMESTAMPTZ(6) NOT NULL,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "telegram_pending_connections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_tg_pending_wallet"
  ON "telegram_pending_connections" ("wallet_pubkey", "claimed");

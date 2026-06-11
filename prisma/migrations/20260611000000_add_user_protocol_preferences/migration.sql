-- CreateTable: per-protocol category and channel overrides for portal users
CREATE TABLE "user_protocol_preferences" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "wallet_hash"      VARCHAR(64)  NOT NULL,
  "protocol_id"      UUID         NOT NULL,
  "opt_in_defi"      BOOLEAN,
  "opt_in_governance" BOOLEAN,
  "opt_in_marketing" BOOLEAN,
  "opt_in_system"    BOOLEAN,
  "channels"         TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "user_protocol_preferences_pkey" PRIMARY KEY ("id")
);

-- UniqueIndex: one row per (user, protocol) pair
CREATE UNIQUE INDEX "user_protocol_preferences_wallet_hash_protocol_id_key"
  ON "user_protocol_preferences"("wallet_hash", "protocol_id");

-- Index: fast lookup by user
CREATE INDEX "user_protocol_preferences_wallet_hash_idx"
  ON "user_protocol_preferences"("wallet_hash");

-- FK: cascade on portal user delete
ALTER TABLE "user_protocol_preferences"
  ADD CONSTRAINT "user_protocol_preferences_wallet_hash_fkey"
  FOREIGN KEY ("wallet_hash") REFERENCES "portal_users"("wallet_hash")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: cascade on protocol delete
ALTER TABLE "user_protocol_preferences"
  ADD CONSTRAINT "user_protocol_preferences_protocol_id_fkey"
  FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

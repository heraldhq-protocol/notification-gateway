-- Add email_verified flag to portal_users
ALTER TABLE "portal_users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;

-- Create email_otp_tokens table
CREATE TABLE "email_otp_tokens" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "wallet_pubkey" VARCHAR(44) NOT NULL,
  "wallet_hash"  VARCHAR(64) NOT NULL,
  "email_hash"   VARCHAR(64) NOT NULL,
  "code_hash"    VARCHAR(64) NOT NULL,
  "expires_at"   TIMESTAMPTZ(6) NOT NULL,
  "attempts"     SMALLINT NOT NULL DEFAULT 0,
  "used_at"      TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "email_otp_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_otp_tokens_wallet_pubkey_idx" ON "email_otp_tokens"("wallet_pubkey");
CREATE INDEX "email_otp_tokens_email_hash_idx" ON "email_otp_tokens"("email_hash");

ALTER TABLE "email_otp_tokens"
  ADD CONSTRAINT "email_otp_tokens_wallet_hash_fkey"
  FOREIGN KEY ("wallet_hash") REFERENCES "portal_users"("wallet_hash") ON DELETE CASCADE ON UPDATE CASCADE;

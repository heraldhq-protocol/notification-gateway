-- AlterTable
ALTER TABLE "unsubscribe_tokens" ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '7 days';

-- CreateTable
CREATE TABLE "portal_users" (
    "wallet_hash" VARCHAR(64) NOT NULL,
    "email_hash" VARCHAR(64),
    "opt_in_all" BOOLEAN NOT NULL DEFAULT true,
    "opt_in_defi" BOOLEAN NOT NULL DEFAULT true,
    "opt_in_governance" BOOLEAN NOT NULL DEFAULT true,
    "opt_in_marketing" BOOLEAN NOT NULL DEFAULT false,
    "digest_mode" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_users_pkey" PRIMARY KEY ("wallet_hash")
);

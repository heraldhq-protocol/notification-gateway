-- AlterTable
ALTER TABLE "team_members" ADD COLUMN     "password_hash" VARCHAR(100),
ADD COLUMN     "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totp_secret" VARCHAR(64);

-- AlterTable
ALTER TABLE "unsubscribe_tokens" ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '7 days';

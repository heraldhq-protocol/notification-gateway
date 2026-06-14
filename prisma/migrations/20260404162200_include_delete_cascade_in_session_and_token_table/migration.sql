-- CleanUp: remove orphaned sessions and tokens that have no matching portal_user row
-- (these were created before the FK constraint was introduced)
DELETE FROM "portal_sessions"
WHERE "wallet_hash" NOT IN (SELECT "wallet_hash" FROM "portal_users");

DELETE FROM "unsubscribe_tokens"
WHERE "wallet_hash" NOT IN (SELECT "wallet_hash" FROM "portal_users");

-- AlterTable
ALTER TABLE "unsubscribe_tokens" ALTER COLUMN "expires_at" SET DEFAULT NOW() + INTERVAL '7 days';

-- AddForeignKey
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_wallet_hash_fkey" FOREIGN KEY ("wallet_hash") REFERENCES "portal_users"("wallet_hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_wallet_hash_fkey" FOREIGN KEY ("wallet_hash") REFERENCES "portal_users"("wallet_hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "protocol_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_pubkey" VARCHAR(44),
    "wallet_hash" VARCHAR(64) NOT NULL,
    "protocol_id" UUID NOT NULL,
    "channels" TEXT[] NOT NULL DEFAULT ARRAY['email'::TEXT],
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "source" VARCHAR(30) NOT NULL DEFAULT 'join_link',
    "subscribed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protocol_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocol_subscriptions_wallet_hash_protocol_id_key"
    ON "protocol_subscriptions"("wallet_hash", "protocol_id");

CREATE INDEX "idx_protocol_subscriptions_protocol_status"
    ON "protocol_subscriptions"("protocol_id", "status");

CREATE INDEX "idx_protocol_subscriptions_wallet"
    ON "protocol_subscriptions"("wallet_hash");

-- AddForeignKey
ALTER TABLE "protocol_subscriptions"
    ADD CONSTRAINT "protocol_subscriptions_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: create subscriptions for wallets already successfully notified.
-- walletPubkey is NULL for these rows (not stored in notifications table).
-- They count toward audience size but are excluded from broadcast targeting
-- until the user explicitly subscribes via the SDK or join link.
INSERT INTO "protocol_subscriptions"
    ("id", "wallet_hash", "protocol_id", "channels", "status", "source", "subscribed_at", "updated_at")
SELECT
    gen_random_uuid(),
    n.wallet_hash,
    n.protocol_id,
    ARRAY['email'::TEXT],
    'active',
    'backfill',
    MIN(n.queued_at),
    NOW()
FROM "notifications" n
WHERE n.status IN ('delivered', 'partial')
GROUP BY n.wallet_hash, n.protocol_id
ON CONFLICT ("wallet_hash", "protocol_id") DO NOTHING;

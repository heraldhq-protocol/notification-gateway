-- CreateTable
CREATE TABLE "protocols" (
    "id" UUID NOT NULL,
    "protocol_pubkey" VARCHAR(44) NOT NULL,
    "name_encrypted" BYTEA NOT NULL,
    "tier" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "sends_this_period" BIGINT NOT NULL DEFAULT 0,
    "period_reset_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '30 days'::interval),
    "subscription_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "key_prefix" VARCHAR(20) NOT NULL,
    "environment" VARCHAR(10) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['notify:write']::TEXT[],
    "name" VARCHAR(100),
    "last_used_at" TIMESTAMPTZ(6),
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "wallet_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "category" VARCHAR(20) NOT NULL DEFAULT 'defi',
    "subject_hash" VARCHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(128),
    "write_receipt" BOOLEAN NOT NULL DEFAULT true,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "receipt_tx" VARCHAR(88),
    "ses_message_id" VARCHAR(100),
    "email_provider" VARCHAR(20),
    "bounce" BOOLEAN NOT NULL DEFAULT false,
    "bounce_type" VARCHAR(10),
    "error_code" VARCHAR(80),
    "retry_count" SMALLINT NOT NULL DEFAULT 0,
    "arweave_id" VARCHAR(100),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY['notification.delivered']::TEXT[],
    "secret_hash" VARCHAR(64) NOT NULL,
    "secret_prefix" VARCHAR(10),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" SMALLINT NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "notification_id" UUID,
    "event" VARCHAR(40) NOT NULL,
    "http_status" SMALLINT,
    "latency_ms" INTEGER,
    "attempt" SMALLINT NOT NULL DEFAULT 1,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dkim_keys" (
    "id" UUID NOT NULL,
    "protocol_id" UUID,
    "domain" VARCHAR(255) NOT NULL,
    "selector" VARCHAR(63) NOT NULL,
    "public_key" TEXT NOT NULL,
    "kms_key_id" VARCHAR(255) NOT NULL,
    "dns_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dkim_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_bounces" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "wallet_hash" VARCHAR(64),
    "bounce_type" VARCHAR(10) NOT NULL,
    "ses_message_id" VARCHAR(100),
    "diagnostic_code" TEXT,
    "bounced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_bounces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_queue" (
    "id" UUID NOT NULL,
    "wallet_hash" VARCHAR(64) NOT NULL,
    "protocol_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "body_arweave_id" VARCHAR(100),
    "category" VARCHAR(20) NOT NULL,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "digest_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "tier" SMALLINT NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'inactive',
    "helio_subscription_id" VARCHAR(100),
    "helio_customer_id" VARCHAR(100),
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "sends_this_period" BIGINT NOT NULL DEFAULT 0,
    "period_reset_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '30 days'::interval),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "amount_usdc" BIGINT NOT NULL,
    "token_symbol" VARCHAR(10) NOT NULL DEFAULT 'USDC',
    "token_mint" VARCHAR(44),
    "payment_source" VARCHAR(30) NOT NULL,
    "helio_transaction_id" VARCHAR(100),
    "solana_tx_signature" VARCHAR(88),
    "periods_paid" SMALLINT NOT NULL DEFAULT 1,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'completed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helio_webhook_events" (
    "id" UUID NOT NULL,
    "helio_event_id" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "protocol_id" UUID,
    "payload_hash" VARCHAR(64) NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helio_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocols_protocol_pubkey_key" ON "protocols"("protocol_pubkey");

-- CreateIndex
CREATE INDEX "idx_protocols_pubkey" ON "protocols"("protocol_pubkey");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_api_keys_hash" ON "api_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_idempotency_key_key" ON "notifications"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_notifications_protocol" ON "notifications"("protocol_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "idx_notifications_wallet" ON "notifications"("wallet_hash");

-- CreateIndex
CREATE INDEX "idx_notifications_status" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "idx_notifications_idem" ON "notifications"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_webhook_del_webhook" ON "webhook_deliveries"("webhook_id", "attempted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dkim_keys_domain_selector_key" ON "dkim_keys"("domain", "selector");

-- CreateIndex
CREATE UNIQUE INDEX "digest_queue_wallet_hash_protocol_id_queued_at_key" ON "digest_queue"("wallet_hash", "protocol_id", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_protocol_id_key" ON "subscriptions"("protocol_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_helio_subscription_id_key" ON "subscriptions"("helio_subscription_id");

-- CreateIndex
CREATE INDEX "idx_subscriptions_status" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "idx_subscriptions_expiry" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "payments_helio_transaction_id_key" ON "payments"("helio_transaction_id");

-- CreateIndex
CREATE INDEX "idx_payments_protocol" ON "payments"("protocol_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "helio_webhook_events_helio_event_id_key" ON "helio_webhook_events"("helio_event_id");

-- CreateIndex
CREATE INDEX "idx_helio_events_type" ON "helio_webhook_events"("event_type", "received_at" DESC);

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dkim_keys" ADD CONSTRAINT "dkim_keys_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_bounces" ADD CONSTRAINT "email_bounces_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digest_queue" ADD CONSTRAINT "digest_queue_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helio_webhook_events" ADD CONSTRAINT "helio_webhook_events_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE SET NULL ON UPDATE CASCADE;

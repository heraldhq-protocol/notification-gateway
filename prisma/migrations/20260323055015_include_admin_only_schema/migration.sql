-- CreateTable
CREATE TABLE "protocol_settings" (
    "protocol_id" UUID NOT NULL,
    "admin_email_hash" VARCHAR(64),
    "admin_email_encrypted" BYTEA,
    "website_url" TEXT,
    "logo_url" TEXT,
    "notification_categories" TEXT[] DEFAULT ARRAY['defi', 'governance', 'system']::TEXT[],
    "custom_from_name" VARCHAR(100),
    "helio_subscription_id" VARCHAR(100),
    "helio_customer_id" VARCHAR(100),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "protocol_settings_pkey" PRIMARY KEY ("protocol_id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "email_hash" VARCHAR(64) NOT NULL,
    "email_encrypted" BYTEA,
    "role" VARCHAR(20) NOT NULL DEFAULT 'developer',
    "wallet_pubkey" VARCHAR(44),
    "name_encrypted" BYTEA,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "invited_by" UUID,
    "invite_token" VARCHAR(100),
    "invite_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "protocol_id" UUID,
    "actor_id" UUID,
    "actor_role" VARCHAR(20),
    "action" VARCHAR(80) NOT NULL,
    "resource_type" VARCHAR(40),
    "resource_id" VARCHAR(100),
    "old_value" JSONB,
    "new_value" JSONB,
    "ip_hash" VARCHAR(64),
    "user_agent" TEXT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unsubscribe_tokens" (
    "token_hash" VARCHAR(64) NOT NULL,
    "wallet_hash" VARCHAR(64) NOT NULL,
    "category" VARCHAR(20),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW() + INTERVAL '7 days',

    CONSTRAINT "unsubscribe_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "portal_sessions" (
    "id" UUID NOT NULL,
    "wallet_hash" VARCHAR(64) NOT NULL,
    "jwt_jti" VARCHAR(36) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_members_invite_token_key" ON "team_members"("invite_token");

-- CreateIndex
CREATE INDEX "team_members_protocol_id_idx" ON "team_members"("protocol_id");

-- CreateIndex
CREATE INDEX "team_members_email_hash_idx" ON "team_members"("email_hash");

-- CreateIndex
CREATE INDEX "team_members_wallet_pubkey_idx" ON "team_members"("wallet_pubkey");

-- CreateIndex
CREATE INDEX "audit_log_protocol_id_timestamp_idx" ON "audit_log"("protocol_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_id_timestamp_idx" ON "audit_log"("actor_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "audit_log_action_timestamp_idx" ON "audit_log"("action", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "unsubscribe_tokens_expires_at_idx" ON "unsubscribe_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "portal_sessions_jwt_jti_key" ON "portal_sessions"("jwt_jti");

-- CreateIndex
CREATE INDEX "portal_sessions_wallet_hash_idx" ON "portal_sessions"("wallet_hash");

-- AddForeignKey
ALTER TABLE "protocol_settings" ADD CONSTRAINT "protocol_settings_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "audiences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "protocol_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "wallets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "wallet_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "protocol_id" UUID NOT NULL,
    "audience_id" UUID NOT NULL,
    "template_id" UUID,
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "category" VARCHAR(30) NOT NULL DEFAULT 'defi',
    "channels" TEXT[] NOT NULL DEFAULT ARRAY['email']::TEXT[],
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_for" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "total_targets" INTEGER NOT NULL DEFAULT 0,
    "total_sent" INTEGER NOT NULL DEFAULT 0,
    "total_failed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "idx_audiences_protocol" ON "audiences"("protocol_id");

-- CreateIndex
CREATE INDEX "idx_campaigns_protocol_status" ON "campaigns"("protocol_id", "status");

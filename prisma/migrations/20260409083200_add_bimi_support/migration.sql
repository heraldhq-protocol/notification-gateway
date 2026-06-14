-- AlterTable
ALTER TABLE "protocol_settings" ADD COLUMN     "bimi_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "logo_verified_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "bimi_records" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "selector" VARCHAR(63) NOT NULL DEFAULT 'default',
    "logo_url" TEXT NOT NULL,
    "vmc_url" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "dmarc_verified" BOOLEAN NOT NULL DEFAULT false,
    "dns_record_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bimi_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bimi_verification_logs" (
    "id" UUID NOT NULL,
    "protocol_id" UUID NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "check_type" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "details" JSONB,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bimi_verification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bimi_records_protocol_id_domain_key" ON "bimi_records"("protocol_id", "domain");

-- AddForeignKey
ALTER TABLE "bimi_records" ADD CONSTRAINT "bimi_records_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bimi_verification_logs" ADD CONSTRAINT "bimi_verification_logs_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

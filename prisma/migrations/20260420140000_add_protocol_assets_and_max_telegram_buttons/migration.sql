-- AddProtocolAssetsAndMaxTelegramButtons
-- Add protocol assets table for brand assets (banner, video, logo) and maxTelegramButtons field

BEGIN;

-- Add maxTelegramButtons column to protocols table
ALTER TABLE "protocols" ADD COLUMN "max_telegram_buttons" SMALLINT;

-- Create protocol_assets table
CREATE TABLE "protocol_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "protocol_id" UUID NOT NULL,
    "asset_type" VARCHAR(20) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "protocol_assets_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "protocol_assets" ADD CONSTRAINT "protocol_assets_protocol_id_asset_type_key" UNIQUE ("protocol_id", "asset_type");

CREATE INDEX "idx_protocol_assets_protocol" ON "protocol_assets" ("protocol_id");

ALTER TABLE "protocol_assets" ADD CONSTRAINT "protocol_assets_protocol_id_fkey" 
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

COMMENT ON TABLE "protocol_assets" IS 'Protocol brand assets (banner, video, logo)';

COMMIT;
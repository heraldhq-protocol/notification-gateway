-- EmailDelivery model
-- Tracks successful SES delivery confirmations from SNS notifications
-- Created: 2026-05-13

BEGIN;

CREATE TABLE IF NOT EXISTS "email_deliveries" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "notification_id" uuid,
    "ses_message_id" varchar(100),
    "smtp_response" text,
    "processing_time_ms" integer,
    "delivered_at" timestamptz(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_email_delivery_ses_id" ON "email_deliveries"("ses_message_id");

COMMIT;

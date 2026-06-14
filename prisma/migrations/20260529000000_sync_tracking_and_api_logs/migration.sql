-- Sync two gateway-owned schema additions that were missing from the shared DB.
-- Safe to re-run — all statements guard against already-applied state.

-- 1. tracking_enabled on notifications
--    Added by gateway migration 20260527000000_add_tracking_enabled_to_notifications.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "tracking_enabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. api_request_logs table
--    Added by gateway migration 20260528000000_add_api_request_logs.
CREATE TABLE IF NOT EXISTS "api_request_logs" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "protocol_id"    UUID         NOT NULL,
  "api_key_id"     UUID,
  "is_test_key"    BOOLEAN      NOT NULL DEFAULT false,
  "method"         VARCHAR(10)  NOT NULL,
  "endpoint"       VARCHAR(200) NOT NULL,
  "request_body"   JSONB,
  "response_body"  JSONB,
  "status_code"    INTEGER      NOT NULL,
  "latency_ms"     INTEGER      NOT NULL,
  "correlation_id" VARCHAR(128),
  "ip_hash"        VARCHAR(64),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "api_request_logs"
    ADD CONSTRAINT "api_request_logs_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "idx_api_request_logs_protocol"
  ON "api_request_logs"("protocol_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_api_request_logs_correlation"
  ON "api_request_logs"("correlation_id");

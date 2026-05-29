-- CreateTable: api_request_logs
-- Stores every authenticated inbound API request for the Request Inspector feature.

CREATE TABLE "api_request_logs" (
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

  CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_request_logs_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_api_request_logs_protocol"     ON "api_request_logs"("protocol_id", "created_at" DESC);
CREATE INDEX "idx_api_request_logs_correlation"   ON "api_request_logs"("correlation_id");

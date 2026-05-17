-- Sprint 5: End-User Reporting
-- Idempotent — safe to run on both admin-api and gateway databases.

CREATE TABLE IF NOT EXISTS notification_reports (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  notification_id  UUID        NOT NULL,
  protocol_id      UUID        NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  wallet_hash      VARCHAR(64) NOT NULL,
  reason           VARCHAR(30) NOT NULL,
  details          VARCHAR(500),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_report_per_wallet UNIQUE (notification_id, wallet_hash)
);

CREATE INDEX IF NOT EXISTS idx_notification_reports_protocol
  ON notification_reports (protocol_id, created_at);

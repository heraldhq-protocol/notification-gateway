-- Sprint 2 — Content Scanning
-- Adds: riskScore and scanVerdict to notifications table

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "risk_score"    SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scan_verdict"  VARCHAR(20);

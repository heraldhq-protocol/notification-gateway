-- AddColumns: provider registration fields on dkim_keys
-- Tracks whether the key has been registered with SES and/or Resend.

ALTER TABLE "dkim_keys"
  ADD COLUMN IF NOT EXISTS "ses_verified"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ses_cname_records" JSONB,
  ADD COLUMN IF NOT EXISTS "resend_domain_id"  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "resend_verified"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "resend_dns_records" JSONB;

-- Design Partner Campaign Fields
-- Adds contact info, pipeline stage, and campaign source for the design partner outreach campaign.
-- Idempotent — safe to re-run.

ALTER TABLE design_partners
  ADD COLUMN IF NOT EXISTS contact_name     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS contact_email    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS pipeline_stage   VARCHAR(30)  NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS campaign_source  VARCHAR(50);

-- Existing partners default to 'active' stage (already signed and live).
-- New prospects added during the campaign will be set to 'prospect'.

CREATE INDEX IF NOT EXISTS idx_design_partners_pipeline_stage
  ON design_partners (pipeline_stage);

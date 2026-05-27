-- AddColumn: tracking_enabled on notifications
-- Marks whether engagement tracking (open pixel + click wrapping) was active
-- when a notification was sent. Only notifications with tracking_enabled = true
-- should count toward engagement rate denominators.

ALTER TABLE "notifications"
  ADD COLUMN "tracking_enabled" BOOLEAN NOT NULL DEFAULT FALSE;

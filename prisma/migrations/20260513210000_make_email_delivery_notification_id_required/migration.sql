-- Make notification_id required on email_deliveries
-- Prisma: notificationId String? → String, notification Notification? → Notification

ALTER TABLE "email_deliveries" ALTER COLUMN "notification_id" SET NOT NULL;

-- Update FK constraint from ON DELETE SET NULL to ON DELETE RESTRICT (required relation)
ALTER TABLE "email_deliveries" DROP CONSTRAINT "email_deliveries_notification_id_fkey";
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

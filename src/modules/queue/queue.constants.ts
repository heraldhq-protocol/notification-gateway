/** BullMQ queue names used across the gateway. */
export const QueueNames = {
  NOTIFICATION: 'notification',
  RECEIPT_BATCH: 'receipt-batch',
  WEBHOOK: 'webhook',
  BOUNCE: 'bounce',
  DIGEST: 'digest',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

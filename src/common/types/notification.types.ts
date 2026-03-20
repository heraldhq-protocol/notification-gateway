/** Status lifecycle for a notification. */
export type NotificationStatus =
  | 'queued'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'opted_out'
  | 'duplicate';

/** Supported notification categories mapped to on-chain opt-in flags. */
export type NotificationCategory =
  | 'defi'
  | 'governance'
  | 'system'
  | 'marketing';

/** On-chain identity account (parsed from Solana PDA). */
export interface IdentityAccount {
  owner: string;
  encryptedEmail: Uint8Array;
  emailHash: Uint8Array;
  nonce: Uint8Array;
  registeredAt: number;
  optInAll: boolean;
  optInDefi: boolean;
  optInGovernance: boolean;
  optInMarketing: boolean;
  digestMode: boolean;
}

/** BullMQ job payload for notification delivery. SEC-001: no email in job data. */
export interface NotificationJobData {
  notificationId: string;
  protocolId: string;
  protocolPubkey: string;
  protocolName: string;
  wallet: string; // base58 pubkey — used for Solana PDA lookup in worker
  subject: string; // No PII — protocol-authored subject
  body: string; // No PII — protocol-authored body
  category: string;
  writeReceipt: boolean;
  digestMode: boolean;
}

/** Webhook event types dispatched by the system. */
export type WebhookEventType =
  | 'notification.delivered'
  | 'notification.failed'
  | 'notification.bounced';

/** Webhook dispatch job payload. */
export interface WebhookJobData {
  webhookId: string;
  url: string;
  secretHash: string;
  event: WebhookEventType;
  payload: Record<string, unknown>;
}

/** Receipt batch item for ZK proof writing. */
export interface ReceiptBatchItem {
  notificationId: string;
  protocolPubkey: string;
  recipientHash: Uint8Array;
  category: number;
  timestamp: number;
}

/** Receipt queue item before batching. */
export interface ReceiptQueueItem {
  notificationId: string;
  protocolPubkey: string;
  walletPubkey: string;
  category: string;
}

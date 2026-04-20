/** Status lifecycle for a notification. */
export type NotificationStatus =
  | 'queued'
  | 'processing'
  | 'delivered'
  | 'partial'
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
  // Channel flags
  channelEmail: boolean;
  channelTelegram: boolean;
  channelSms: boolean;
  // Telegram channel
  encryptedTelegramId: Uint8Array;
  telegramIdHash: Uint8Array;
  nonceTelegram: Uint8Array;
  // SMS channel
  encryptedPhone: Uint8Array;
  phoneHash: Uint8Array;
  nonceSms: Uint8Array;
}

/** BullMQ job payload for notification delivery. SEC-001: no PII in job data. */
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
  // Priority: adds SMS for important/critical
  priority?: 'normal' | 'important' | 'critical';
  // Explicit channels (from batch level or individual)
  channels?: ('email' | 'telegram' | 'sms')[];
  // Channels to exclude
  excludedChannels?: ('email' | 'telegram' | 'sms')[];
  // Individual preferred channel (takes precedence over batch channels)
  preferredChannel?: 'email' | 'telegram' | 'sms';
  // Sandbox fields — only present when isSandbox = true
  isSandbox?: boolean;
  testContact?: {
    email?: string;
    telegramChatId?: string;
    phone?: string;
  };
  tier?: number; // Protocol tier — used for template selection
  templateId?: string;
  telegramTemplateId?: string;
  templateVariables?: Record<string, string>;
}

/**
 * Decrypted channel identifiers — exist ONLY in-memory.
 * Returned by the enclave service after a single decrypt-all call.
 * SEC-001: These values MUST NEVER be logged, stored, or returned via API.
 */
export interface DecryptedChannels {
  email?: string;
  telegramChatId?: string;
  phone?: string;
}

/** Result of delivering to a single channel. */
export interface ChannelDeliveryOutcome {
  channel: 'email' | 'telegram' | 'sms' | 'unknown';
  success: boolean;
  messageId?: string;
  provider?: string;
  error?: string;
}

/** Result of dispatching to all active channels. */
export interface ChannelDispatchResult {
  outcomes: ChannelDeliveryOutcome[];
  totalChannels: number;
  successCount: number;
  allDelivered: boolean;
}

/** Webhook event types dispatched by the system. */
export type WebhookEventType =
  | 'notification.delivered'
  | 'notification.failed'
  | 'notification.bounced'
  | 'notification.partial';

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

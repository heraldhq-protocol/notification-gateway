import {
  IsString,
  MaxLength,
  IsIn,
  IsBoolean,
  IsOptional,
  IsUUID,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const NOTIFY_CHANNELS = ['email', 'telegram', 'sms'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NOTIFY_PRIORITIES = ['normal', 'important', 'critical'] as const;
export type NotifyPriority = (typeof NOTIFY_PRIORITIES)[number];

/**
 * DTO for POST /v1/notify — single notification send.
 */
export class NotifyDto {
  @ApiProperty({
    description: 'Solana wallet public key (base58-encoded, 32–44 chars)',
    example: 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB8fGgrru3vaE',
  })
  @IsString()
  wallet: string;

  @ApiProperty({
    description:
      'Notification subject line (shown as email subject, Telegram heading, etc.)',
    example:
      '⚠️ Liquidation Warning — Your SOL position is below safe threshold',
    maxLength: 150,
  })
  @IsString()
  @MaxLength(150)
  subject: string;

  @ApiProperty({
    description:
      'Notification body (markdown supported for email and Telegram). ' +
      'Max 10,000 characters.',
    example: [
      '**Position at risk**',
      '',
      'Your collateral health factor has dropped to **1.03** on MarginFi.',
      '',
      '| Asset     | Amount     | Value (USD) |',
      '|-----------|------------|-------------|',
      '| SOL (col) | 12.5 SOL   | $1,512.50   |',
      '| USDC (borrow) | 1,400 | $1,400.00   |',
      '',
      'Add collateral or repay part of your loan to avoid liquidation.',
      '',
      '[Manage Position →](https://app.marginfi.com)',
    ].join('\n'),
    maxLength: 10000,
  })
  @IsString()
  @MaxLength(10000)
  body: string;

  @ApiPropertyOptional({
    description:
      'Notification category. Controls opt-in filtering — users who opted out ' +
      'of a category will not receive this notification.',
    enum: ['defi', 'governance', 'system', 'marketing', 'security'],
    default: 'defi',
    example: 'defi',
  })
  @IsOptional()
  @IsIn(['defi', 'governance', 'system', 'marketing', 'security'])
  category?: string = 'defi';

  @ApiPropertyOptional({
    description:
      'Preferred delivery channel. When set, Herald will attempt this channel first. ' +
      'Falls back to the next available channel if recipient has not registered the preferred one. ' +
      'Omit to let Herald choose based on user preferences.',
    enum: NOTIFY_CHANNELS,
    example: 'email',
  })
  @IsOptional()
  @IsIn(NOTIFY_CHANNELS)
  preferred_channel?: NotifyChannel;

  @ApiPropertyOptional({
    description:
      'Priority level. When "important" or "critical", SMS is added as a fallback channel ' +
      '(alongside email and telegram) if the recipient has SMS registered. ' +
      'Explicit channels list takes precedence over priority flag.',
    enum: NOTIFY_PRIORITIES,
    default: 'normal',
    example: 'important',
  })
  @IsOptional()
  @IsIn(NOTIFY_PRIORITIES)
  priority?: NotifyPriority = 'normal';

  @ApiPropertyOptional({
    description:
      'Write a ZK delivery receipt to Solana mainnet after delivery. ' +
      'Counts against your on-chain receipt quota. Set false for high-volume sends.',
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  receipt?: boolean = true;

  @ApiPropertyOptional({
    description:
      'UUID v4 idempotency key — Herald will deduplicate sends with the same key ' +
      'within a 24-hour window (1 hour in sandbox). Generate a fresh UUID per send.',
    example: 'a3f7b2c1-4d8e-4f2a-9b1c-2e3d4f5a6b7c',
  })
  @IsOptional()
  @IsUUID(4)
  idempotencyKey?: string;

  @ApiPropertyOptional({
    description:
      'Custom email template ID (Growth+ tier). ' +
      'Template must belong to this protocol and match the category.',
    example: 'tmpl_liquidation_warning_v2',
  })
  @IsOptional()
  @IsString()
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Custom Telegram template ID (Scale+ tier).',
    example: 'tg_tmpl_liquidation_alert',
  })
  @IsOptional()
  @IsString()
  telegramTemplateId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  batchChannels?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  batchExcludeChannels?: string[];

  @ApiPropertyOptional({
    description:
      'Key-value pairs injected into template placeholders ({{variable_name}}). ' +
      'All values must be strings.',
    example: {
      health_factor: '1.03',
      position_value_usd: '$1,512.50',
      borrow_value_usd: '$1,400.00',
      protocol_name: 'MarginFi',
      action_url: 'https://app.marginfi.com',
    },
  })
  @IsOptional()
  templateVariables?: Record<string, string>;
}

/**
 * DTO for POST /v1/notify/batch — up to 100 notifications.
 */
export class NotifyBatchDto {
  @ApiProperty({
    description: 'Array of notification payloads (max 100 per batch)',
    type: [NotifyDto],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => NotifyDto)
  notifications: NotifyDto[];

  @ApiPropertyOptional({
    description:
      'Explicit channels to use for ALL notifications in this batch. ' +
      'Cannot be used with exclude_channels. Individual notifications can override with preferred_channel.',
    enum: NOTIFY_CHANNELS,
    isArray: true,
    example: ['email', 'telegram'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(NOTIFY_CHANNELS, { each: true })
  @ValidateIf((o) => o.exclude_channels !== undefined)
  channels?: string[];

  @ApiPropertyOptional({
    description:
      'Channels to exclude for ALL notifications in this batch. ' +
      'Cannot be used with channels.',
    enum: NOTIFY_CHANNELS,
    isArray: true,
    example: ['sms'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(NOTIFY_CHANNELS, { each: true })
  @ValidateIf((o) => o.channels !== undefined)
  exclude_channels?: string[];
}

/**
 * Response DTO for notify endpoints.
 */
export class NotifyResponseDto {
  @ApiProperty({
    description: 'Unique notification ID (UUID)',
    example: '018e4f2a-6b7c-7d8e-9f0a-1b2c3d4e5f6a',
  })
  notification_id: string;

  @ApiProperty({
    description:
      'Current status of the notification. ' +
      '`queued` — accepted and being delivered. ' +
      '`opted_out` — recipient has opted out of this category. ' +
      '`duplicate` — same idempotency key seen within dedup window. ' +
      '`failed` — delivery could not be attempted (see error_code).',
    enum: ['queued', 'opted_out', 'duplicate', 'failed'],
    example: 'queued',
  })
  status: 'queued' | 'opted_out' | 'duplicate' | 'failed';

  @ApiProperty({
    description: 'Whether the recipient wallet is registered with Herald',
    example: true,
  })
  recipient_registered: boolean;

  @ApiProperty({
    description: 'Estimated delivery time in milliseconds from now',
    example: 1800,
  })
  estimated_delivery_ms: number;

  @ApiPropertyOptional({
    description:
      'Solana transaction signature of the ZK delivery receipt (null if receipt=false)',
    example:
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBwFMbSPLqBnFPTyKWQtMbNJyBq2HY9FH1tBe3UyB3BMDK9a',
  })
  receipt_tx: string | null;

  @ApiPropertyOptional({
    description:
      'The channel Herald will deliver through (resolved after routing)',
    enum: NOTIFY_CHANNELS,
    example: 'email',
  })
  delivery_channel?: NotifyChannel | null;

  @ApiPropertyOptional({
    description: 'Deployment environment of the API key used',
    enum: ['sandbox', 'production'],
    example: 'production',
  })
  environment?: 'sandbox' | 'production';

  @ApiPropertyOptional({
    description: 'True when request was made with a sandbox (hrld_test_) key',
    example: false,
  })
  sandbox_mode?: boolean;

  @ApiPropertyOptional({
    description:
      'Machine-readable error identifier — only present when status is `failed`',
    example: 'SANDBOX_NO_TEST_CONTACT',
  })
  error_code?: string;

  @ApiPropertyOptional({
    description:
      'Masked test contact details — only present in sandbox mode. ' +
      'Shows where the notification was actually delivered.',
    example: {
      email: 'de***@yourcompany.io',
      telegram: 'configured',
      sms: null,
    },
  })
  test_contact?: {
    email?: string | null;
    telegram?: string | null;
    sms?: string | null;
  };

  @ApiPropertyOptional({
    description: 'Informational notes about sandbox delivery behaviour',
    example: [
      'Delivering to devnet-registered channels (decrypted via ENCLAVE_TEST_KEY).',
      'This notification will NOT count against your production monthly quota.',
      'Sandbox daily usage: 8 of 100 remaining after this send.',
      'ZK receipt disabled in sandbox mode.',
    ],
  })
  sandbox_notes?: string[];
}

/**
 * Response DTO for GET /v1/notifications/:id — notification status.
 */
export class NotificationStatusDto {
  @ApiProperty({ example: '018e4f2a-6b7c-7d8e-9f0a-1b2c3d4e5f6a' })
  notification_id: string;

  @ApiProperty({ example: 'delivered' })
  status: string;

  @ApiProperty({ example: 'defi' })
  category: string;

  @ApiProperty({ example: '2026-04-19T14:23:01.000Z' })
  created_at: string;

  @ApiPropertyOptional({ example: '2026-04-19T14:23:03.412Z' })
  delivered_at: string | null;

  @ApiPropertyOptional({
    example: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBwFMbSPLqBnFP...',
  })
  receipt_tx: string | null;

  @ApiPropertyOptional({ example: 'ses' })
  email_provider: string | null;

  @ApiProperty({ example: false })
  bounce: boolean;
}

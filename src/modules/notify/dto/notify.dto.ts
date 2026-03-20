import {
  IsString,
  MaxLength,
  IsIn,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for POST /v1/notify — single notification send.
 */
export class NotifyDto {
  @ApiProperty({
    description: 'Solana wallet public key (base58)',
    example: '7xR4mKp2nQwBvTsYjL8dHcFoEa3ZiXuWYnRp',
  })
  @IsString()
  wallet: string;

  @ApiProperty({
    description: 'Email subject line',
    example: 'Liquidation Warning — Action Required',
    maxLength: 150,
  })
  @IsString()
  @MaxLength(150)
  subject: string;

  @ApiProperty({
    description: 'Notification body text (markdown supported)',
    maxLength: 10000,
  })
  @IsString()
  @MaxLength(10000)
  body: string;

  @ApiPropertyOptional({
    description: 'Notification category',
    enum: ['defi', 'governance', 'system', 'marketing'],
    default: 'defi',
  })
  @IsOptional()
  @IsIn(['defi', 'governance', 'system', 'marketing'])
  category?: string = 'defi';

  @ApiPropertyOptional({
    description: 'Whether to write a ZK delivery receipt on Solana',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  receipt?: boolean = true;

  @ApiPropertyOptional({
    description:
      'UUID v4 idempotency key — prevents duplicate sends within 24h',
  })
  @IsOptional()
  @IsUUID(4)
  idempotencyKey?: string;
}

/**
 * DTO for POST /v1/notify/batch — up to 100 notifications.
 */
export class NotifyBatchDto {
  @ApiProperty({
    description: 'Array of notification payloads (max 100)',
    type: [NotifyDto],
  })
  notifications: NotifyDto[];
}

/**
 * Response DTO for notify endpoints.
 */
export class NotifyResponseDto {
  @ApiProperty({ description: 'Unique notification ID (ULID)' })
  notification_id: string;

  @ApiProperty({
    description: 'Current status',
    enum: ['queued', 'opted_out', 'duplicate', 'failed'],
  })
  status: 'queued' | 'opted_out' | 'duplicate' | 'failed';

  @ApiProperty({ description: 'Whether the wallet is registered with Herald' })
  recipient_registered: boolean;

  @ApiProperty({ description: 'Estimated delivery time in milliseconds' })
  estimated_delivery_ms: number;

  @ApiPropertyOptional({ description: 'Solana receipt transaction signature' })
  receipt_tx: string | null;
}

/**
 * Response DTO for GET /v1/notifications/:id — notification status.
 */
export class NotificationStatusDto {
  @ApiProperty() notification_id: string;
  @ApiProperty() status: string;
  @ApiProperty() category: string;
  @ApiProperty() created_at: string;
  @ApiPropertyOptional() delivered_at: string | null;
  @ApiPropertyOptional() receipt_tx: string | null;
  @ApiPropertyOptional() email_provider: string | null;
  @ApiProperty() bounce: boolean;
}

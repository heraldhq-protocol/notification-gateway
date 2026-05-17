import {
  IsString,
  IsArray,
  IsIn,
  IsOptional,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const SUBSCRIBE_CHANNELS = ['email', 'telegram', 'sms'] as const;

export class SubscribeDto {
  @ApiProperty({ description: 'Solana wallet address (base58)' })
  @IsString()
  walletAddress: string;

  @ApiPropertyOptional({
    description: 'Channels to subscribe to',
    enum: SUBSCRIBE_CHANNELS,
    isArray: true,
    default: ['email'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(SUBSCRIBE_CHANNELS, { each: true })
  channels?: string[];
}

export class SubscriptionStatusDto {
  @ApiProperty()
  walletAddress: string;

  @ApiProperty()
  isSubscribed: boolean;

  @ApiProperty({ isArray: true })
  channels: string[];

  @ApiProperty()
  subscribedAt: string | null;
}

export class SubscriberCountDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  byChannel: Record<string, number>;
}

export class InternalSubscribeDto {
  @ApiProperty()
  @IsString()
  walletPubkey: string;

  @ApiProperty()
  @IsString()
  protocolId: string;

  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @IsArray()
  channels?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source?: string;
}

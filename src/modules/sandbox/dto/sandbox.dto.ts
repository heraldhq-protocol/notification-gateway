import {
  IsString,
  MaxLength,
  IsIn,
  IsOptional,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export function IsBodyLengthValid(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBodyLengthValid',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const dto = args.object as SandboxSendDto;
          if (typeof value !== 'string') return false;

          if (dto.preferred_channel === 'sms' && value.length > 1600)
            return false;
          if (dto.preferred_channel === 'telegram' && value.length > 4096)
            return false;

          return value.length <= 10000;
        },
        defaultMessage(args: ValidationArguments) {
          const dto = args.object as SandboxSendDto;
          if (dto.preferred_channel === 'sms')
            return 'Body cannot exceed 1600 characters for SMS.';
          if (dto.preferred_channel === 'telegram')
            return 'Body cannot exceed 4096 characters for Telegram.';
          return 'Body cannot exceed 10000 characters.';
        },
      },
    });
  };
}

export const SANDBOX_CHANNELS = ['email', 'telegram', 'sms'] as const;
export type SandboxChannel = (typeof SANDBOX_CHANNELS)[number];

export const SANDBOX_CATEGORIES = [
  'defi',
  'governance',
  'system',
  'marketing',
  'security',
] as const;
export type SandboxCategory = (typeof SANDBOX_CATEGORIES)[number];

export class SandboxSendDto {
  @ApiProperty({
    description:
      'Notification subject line (shown as email subject, Telegram heading, etc.)',
    example: '⚠️ Liquidation Warning — Test alert from playground',
    maxLength: 150,
  })
  @IsString()
  @MaxLength(150)
  subject: string;

  @ApiProperty({
    description:
      'Notification body (markdown supported). ' +
      'Max 10,000 characters for email, 4,096 for Telegram, and 1,600 for SMS.',
    example: '**Test notification**\n\nThis is a playground test sent to your configured test contacts.',
    maxLength: 10000,
  })
  @IsString()
  @IsBodyLengthValid()
  body: string;

  @ApiPropertyOptional({
    description: 'Notification category.',
    enum: ['defi', 'governance', 'system', 'marketing', 'security'],
    default: 'defi',
  })
  @IsOptional()
  @IsIn(['defi', 'governance', 'system', 'marketing', 'security'])
  category?: string = 'defi';

  @ApiPropertyOptional({
    description:
      'Preferred delivery channel. When set, Herald will attempt this channel first. ' +
      'Falls back to other configured test contacts if this channel is not set.',
    enum: ['email', 'telegram', 'sms'],
  })
  @IsOptional()
  @IsIn(['email', 'telegram', 'sms'])
  preferred_channel?: SandboxChannel;
}

export class SandboxSendResponseDto {
  @ApiProperty({
    description: 'Unique notification ID (UUID)',
    example: '018e4f2a-6b7c-7d8e-9f0a-1b2c3d4e5f6a',
  })
  notification_id: string;

  @ApiProperty({
    description:
      'Current status of the notification. ' +
      '`queued` — accepted and being delivered. ' +
      '`failed` — delivery could not be attempted (see error_code).',
    enum: ['queued', 'failed'],
    example: 'queued',
  })
  status: 'queued' | 'failed';

  @ApiProperty({
    description:
      'Masked test contact details showing where the notification is being delivered.',
    example: {
      email: 'de***@example.com',
      telegram: 'configured',
      sms: null,
    },
  })
  test_contact: {
    email?: string | null;
    telegram?: string | null;
    sms?: string | null;
  };

  @ApiProperty({
    description: 'Remaining playground sends for today',
    example: 24,
  })
  remaining_today: number;

  @ApiProperty({
    description: 'Daily limit for playground sends',
    example: 25,
  })
  daily_limit: number;

  @ApiProperty({
    description: 'Always true for sandbox endpoint responses',
    example: true,
  })
  sandbox_mode: true;

  @ApiProperty({
    description: 'Informational notes about the sandbox delivery',
    example: [
      'Delivering playground test to your configured test contacts.',
      'This notification will NOT count against your production monthly quota.',
      'Playground daily usage: 24 of 25 remaining after this send.',
    ],
  })
  sandbox_notes: string[];

  @ApiPropertyOptional({
    description:
      'Machine-readable error identifier — only present when status is `failed`',
    example: 'SANDBOX_NO_TEST_CONTACT',
  })
  error_code?: string;
}

import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsObject,
  MaxLength,
  MinLength,
  IsNumber,
  IsArray,
  ValidateNested,
  IsUUID,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export const MAX_TEMPLATE_SIZE = 51200;

export enum HeraldFooterTier {
  FULL = 'full',
  SMALL = 'small',
  MINIMAL = 'minimal',
  NONE = 'none',
  ENTERPRISE = 'enterprise',
}

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  subjectTemplate?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TEMPLATE_SIZE)
  htmlSource: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  textSource?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  previewText?: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsEnum(HeraldFooterTier)
  @IsOptional()
  heraldFooter?: HeraldFooterTier;
}

export class PreviewTemplateDto {
  @IsObject()
  @IsOptional()
  variables?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  previewText?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  subject?: string;
}

export class ValidateTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TEMPLATE_SIZE)
  htmlSource: string;

  @IsObject()
  @IsOptional()
  variables?: Record<string, unknown>;
}

export class ValidateTemplateResponseDto {
  valid: boolean;
  format?: 'mjml' | 'html';
  errors: string[];
  warnings: string[];
}

export class UpdateTemplateDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  subjectTemplate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(MAX_TEMPLATE_SIZE)
  htmlSource?: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  textSource?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  previewText?: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsEnum(HeraldFooterTier)
  @IsOptional()
  heraldFooter?: HeraldFooterTier;
}

export class TemplateVersionDto {
  @IsUUID()
  id: string;

  @IsNumber()
  version: number;

  @IsString()
  @IsOptional()
  subjectTemplate?: string;

  @IsString()
  createdAt: Date;
}

export class TemplateVersionsResponseDto {
  templateId: string;
  versions: TemplateVersionDto[];
}

export class TemplateResponseDto {
  @IsUUID()
  id: string;

  @IsString()
  name: string;

  @IsString()
  category: string;

  @IsString()
  @IsOptional()
  subjectTemplate?: string;

  @IsString()
  @IsOptional()
  previewText?: string;

  @IsEnum(HeraldFooterTier)
  heraldFooter: HeraldFooterTier;

  @IsBoolean()
  isDefault: boolean;

  @IsBoolean()
  isActive: boolean;

  @IsNumber()
  version: number;

  @IsString()
  createdAt: Date;

  @IsString()
  updatedAt: Date;
}

export class PreviewResponseDto {
  success: boolean;
  preview: {
    html: string;
    text: string;
    subject: string;
    warnings: string[];
  };
}

export class TemplateListResponseDto {
  data: TemplateResponseDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class TemplateDefaultVariablesDto {
  @IsString()
  @IsOptional()
  protocolName?: string;

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  actionUrl?: string;

  @IsString()
  @IsOptional()
  actionLabel?: string;

  @IsString()
  @IsOptional()
  recipientAddress?: string;

  @IsString()
  @IsOptional()
  txHash?: string;

  @IsString()
  @IsOptional()
  previewText?: string;

  @IsString()
  @IsOptional()
  unsubscribeUrl?: string;
}

export const DEFAULT_PREVIEW_VARIABLES: Record<string, unknown> = {
  protocolName: 'Example Protocol',
  subject: 'Important Notification',
  body: 'This is a sample notification body with important information about your DeFi position. Click the button below to take action.',
  category: 'defi',
  actionUrl: 'https://example.com/action',
  actionLabel: 'View Details',
  recipientAddress: '7xKXtg2cq8N4X5Yz9R5W5J5B5X5Z5X5Z5X5Z5X5Z5X5',
  txHash: '5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x5x',
  previewText:
    'This is the preview text shown in email clients after the subject line...',
  unsubscribeUrl: 'https://notify.useherald.xyz/unsubscribe/test123',
};

import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  IsString,
  IsUrl,
  IsArray,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { PrismaService } from '../../database/prisma.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import { encryptWebhookSecret } from '../../common/crypto/webhook-crypto';
import { WebhookService } from './webhook.service';

// ── DTOs ───────────────────────────────────────────────────────────

export class CreateWebhookDto {
  @ApiProperty({
    description: 'Webhook endpoint URL (HTTPS required in production)',
  })
  @IsUrl()
  url: string;

  @ApiPropertyOptional({
    description: 'Events to subscribe to',
    default: ['notification.delivered'],
    example: [
      'notification.delivered',
      'notification.failed',
      'notification.bounced',
    ],
  })
  @IsOptional()
  @IsArray()
  events?: string[] = ['notification.delivered'];

  @ApiPropertyOptional({ description: 'Display name for the webhook' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class UpdateWebhookDto {
  @ApiPropertyOptional() @IsOptional() @IsUrl() url?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() events?: string[];
  @ApiPropertyOptional() @IsOptional() isActive?: boolean;
}

export class WebhookResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() url: string;
  @ApiProperty() events: string[];
  @ApiPropertyOptional({ description: 'Shown ONCE upon creation' })
  secret?: string;
  @ApiProperty() is_active: boolean;
  @ApiPropertyOptional() failure_count?: number;
  @ApiPropertyOptional() last_success_at?: string | null;
  @ApiProperty() created_at: string;
}

export class WebhookUpdateResponseDto {
  @ApiProperty() updated: boolean;
}

// ── Controller ─────────────────────────────────────────────────────

@ApiTags('Webhooks')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/webhooks')
export class WebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookService: WebhookService,
  ) {}

  @Post()
  @RequiredScopes('webhook:write')
  @ApiOperation({ summary: 'Register a webhook endpoint' })
  @ApiResponse({
    status: 201,
    description: 'Webhook created',
    type: WebhookResponseDto,
  })
  async create(
    @Body() dto: CreateWebhookDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<WebhookResponseDto> {
    const secret = bs58.encode(randomBytes(32));
    const encryptedSecret = encryptWebhookSecret(secret);

    const webhook = await this.prisma.webhook.create({
      data: {
        protocolId: protocol.protocolId,
        url: dto.url,
        events: dto.events ?? ['notification.delivered'],
        secretHash: encryptedSecret,
        secretPrefix: secret.substring(0, 8),
      },
    });

    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret, // Used by the client to verify HMAC signatures
      is_active: webhook.isActive,
      created_at: webhook.createdAt.toISOString(),
    };
  }

  @Get()
  @RequiredScopes('webhook:read')
  @ApiOperation({ summary: 'List registered webhooks' })
  @ApiResponse({ status: 200, type: [WebhookResponseDto] })
  async list(
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<WebhookResponseDto[]> {
    const webhooks = await this.prisma.webhook.findMany({
      where: { protocolId: protocol.protocolId },
      orderBy: { createdAt: 'desc' },
    });

    return webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      is_active: w.isActive,
      failure_count: w.failureCount,
      last_success_at: w.lastSuccessAt?.toISOString() ?? null,
      created_at: w.createdAt.toISOString(),
    }));
  }

  @Patch(':id')
  @RequiredScopes('webhook:write')
  @ApiOperation({ summary: 'Update webhook (events, url, active status)' })
  @ApiResponse({ status: 200, type: WebhookUpdateResponseDto })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<WebhookUpdateResponseDto> {
    const webhook = await this.prisma.webhook.updateMany({
      where: { id, protocolId: protocol.protocolId },
      data: {
        ...(dto.url && { url: dto.url }),
        ...(dto.events && { events: dto.events }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    return { updated: webhook.count > 0 };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiredScopes('webhook:write')
  @ApiOperation({ summary: 'Remove webhook endpoint' })
  async remove(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    await this.prisma.webhook.deleteMany({
      where: { id, protocolId: protocol.protocolId },
    });
  }

  @Post(':id/test')
  @RequiredScopes('webhook:write')
  @ApiOperation({ summary: 'Send a test payload to webhook endpoint' })
  async test(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const webhook = await this.prisma.webhook.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });
    if (!webhook) return { error: 'Webhook not found' };

    await this.webhookService.dispatch(protocol.protocolId, 'ping', {
      message: 'Hello from Herald Notification Gateway!',
      webhookId: webhook.id,
    });

    return {
      message: 'Test webhook dispatched',
      webhook_id: webhook.id,
      url: webhook.url,
    };
  }
}

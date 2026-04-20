import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { NotifyService } from './notify.service';
import {
  NotifyDto,
  NotifyBatchDto,
  NotifyResponseDto,
  NotificationStatusDto,
} from './dto/notify.dto';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { SubscriptionGuard } from '../billing/subscription/subscription.guard';
import { RateLimitInterceptor } from '../../common/interceptors/rate-limit.interceptor';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { TemplateService } from '../template/template.service';

/**
 * NotifyController — notification send and status endpoints.
 *
 * All endpoints require Bearer authentication (API key).
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@UseInterceptors(RateLimitInterceptor)
@Controller('v1')
export class NotifyController {
  constructor(
    private readonly notifyService: NotifyService,
    private readonly templateService: TemplateService,
  ) {}

  /**
   * POST /v1/notify — Send a single notification.
   * Returns 202 Accepted with notification_id (async delivery).
   */
  @Post('notify')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SubscriptionGuard)
  @RequiredScopes('notify:write')
  @ApiOperation({
    summary: 'Send a notification to a wallet',
    description:
      'Validates the wallet, checks opt-in, and enqueues for async delivery. ' +
      'Returns 202 immediately. Use GET /v1/notifications/:id to poll status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Notification queued',
    type: NotifyResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({
    status: 404,
    description: 'Wallet not registered with Herald',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async notify(
    @Body() dto: NotifyDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<NotifyResponseDto> {
    return this.notifyService.queueNotification(dto, protocol);
  }

  /**
   * POST /v1/notify/batch — Send up to 100 notifications.
   */
  @Post('notify/batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SubscriptionGuard)
  @RequiredScopes('notify:write')
  @ApiOperation({
    summary: 'Send batch notifications (up to 100)',
    description:
      'Each notification is processed independently. Returns array of results.',
  })
  @ApiResponse({
    status: 202,
    description: 'Batch queued',
    type: [NotifyResponseDto],
  })
  async notifyBatch(
    @Body() dto: NotifyBatchDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<NotifyResponseDto[]> {
    if (dto.channels && dto.exclude_channels) {
      throw new BadRequestException({
        error: 'INVALID_BATCH_CHANNELS',
        message: 'Cannot specify both channels and exclude_channels',
      });
    }

    const batchChannels = dto.channels;
    const batchExcludeChannels = dto.exclude_channels;

    const results = await Promise.allSettled(
      dto.notifications.map((n) => {
        const mergedDto = { ...n };
        if (batchChannels !== undefined) {
          mergedDto.batchChannels = batchChannels;
        }
        if (batchExcludeChannels !== undefined) {
          mergedDto.batchExcludeChannels = batchExcludeChannels;
        }
        return this.notifyService.queueNotification(mergedDto, protocol);
      }),
    );

    return results.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        notification_id: '',
        status: 'failed' as const,
        recipient_registered: false,
        estimated_delivery_ms: 0,
        receipt_tx: null,
      };
    });
  }

  /**
   * GET /v1/notifications/:id — Get notification status.
   */
  @Get('notifications/:id')
  @RequiredScopes('notify:read')
  @ApiOperation({ summary: 'Get notification status and receipt' })
  @ApiParam({ name: 'id', description: 'Notification ID (ULID)' })
  @ApiResponse({ status: 200, type: NotificationStatusDto })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async getStatus(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<NotificationStatusDto> {
    return this.notifyService.getNotificationStatus(id, protocol.protocolId);
  }

  /**
   * GET /v1/notifications — List notifications (paginated).
   */
  @Get('notifications')
  @RequiredScopes('notify:read')
  @ApiOperation({ summary: 'List notifications for your protocol' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(
    @Query() pagination: PaginationDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.notifyService.listNotifications(
      protocol.protocolId,
      pagination.page,
      pagination.limit,
    );
  }

  /**
   * POST /v1/preview — Render notification preview without sending.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequiredScopes('notify:write')
  @ApiOperation({
    summary: 'Preview notification rendering (email HTML, Telegram message)',
  })
  @ApiResponse({
    status: 200,
    description: 'Preview rendered successfully',
  })
  async preview(
    @Body() dto: NotifyDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<{ renderedHtml?: string; telegramText?: string; smsText?: string }> {
    const category = dto.category ?? 'defi';
    const subject = dto.subject ?? 'Notification';
    
    // Map category to template name (defi folder contains defi-alert template)
    const templateName = category === 'defi' ? 'defi-alert' : category;

    const formattedSubject = `[${protocol.name ?? 'Protocol'} | ${category.charAt(0).toUpperCase() + category.slice(1)} Alert] ${subject}`;

    const { html } = await this.templateService.render({
      template: templateName,
      variables: {
        protocolName: protocol.name ?? 'Protocol',
        subject: formattedSubject,
        body: dto.body,
        category,
        recipientAddress: dto.wallet,
        unsubscribeUrl: `https://notify.useherald.xyz/unsubscribe/preview`,
        heraldLogoUrl: 'https://cdn.useherald.xyz/logo-email.png',
      },
    });

    const telegramText = this.buildTelegramPreview(dto.subject, dto.body, category);
    const smsText = this.buildSmsPreview(protocol.name ?? 'Protocol', subject, dto.body);

    return {
      renderedHtml: html,
      telegramText,
      smsText,
    };
  }

  private buildTelegramPreview(subject: string, body: string, category: string): string {
    const emoji: Record<string, string> = {
      defi: '💰',
      governance: '🗳️',
      system: '⚙️',
      marketing: '📢',
      security: '🔒',
    };
    const icon = emoji[category] ?? '🔔';
    return `${icon} <b>Preview</b>\n\n<b>${subject}</b>\n\n${body}\n\n<i>via Herald • ${category}</i>`;
  }

  private buildSmsPreview(protocolName: string, subject: string, body: string): string {
    const truncatedBody = body.length > 120 ? body.slice(0, 119) + '…' : body;
    return `[${protocolName}] ${subject}: ${truncatedBody} (via Herald)`;
  }
}

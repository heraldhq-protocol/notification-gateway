import {
  Controller,
  Post,
  Get,
  Delete,
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
import { SchedulerService } from './scheduler.service';
import {
  NotifyDto,
  NotifyBatchDto,
  NotifyResponseDto,
  NotificationStatusDto,
  BroadcastDto,
  BroadcastResponseDto,
  ScheduleOnceDto,
  ScheduleRecurringDto,
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
    private readonly schedulerService: SchedulerService,
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
   * POST /v1/notify/broadcast — fan-out to all active subscribers.
   *
   * Targets every wallet that subscribed to this protocol via the join link
   * or the SDK "Enable Notifications" button. Backfilled legacy audience members
   * (known only by hash) are counted but skipped until they re-subscribe explicitly.
   */
  @Post('notify/broadcast')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SubscriptionGuard)
  @RequiredScopes('notify:write')
  @ApiOperation({
    summary: 'Broadcast notification to all active subscribers',
    description:
      'Queues one notification per active subscriber. Returns 202 with queued_count. ' +
      'Skips legacy backfilled rows that lack a wallet pubkey.',
  })
  @ApiResponse({
    status: 202,
    description: 'Broadcast queued',
    type: BroadcastResponseDto,
  })
  async broadcast(
    @Body() dto: BroadcastDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<BroadcastResponseDto> {
    return this.notifyService.queueBroadcast(dto, protocol);
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
  ): Promise<{
    renderedHtml?: string;
    telegramText?: string;
    smsText?: string;
  }> {
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

    const telegramText = this.buildTelegramPreview(
      dto.subject,
      dto.body,
      category,
    );
    const smsText = this.buildSmsPreview(
      protocol.name ?? 'Protocol',
      subject,
      dto.body,
    );

    return {
      renderedHtml: html,
      telegramText,
      smsText,
    };
  }

  /**
   * POST /v1/schedule — Schedule a one-time notification for future delivery.
   */
  @Post('schedule')
  @HttpCode(HttpStatus.CREATED)
  @RequiredScopes('notify:write')
  @ApiOperation({ summary: 'Schedule a one-time notification' })
  @ApiResponse({ status: 201, description: 'Scheduled notification created' })
  async scheduleOnce(
    @Body() dto: ScheduleOnceDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.schedulerService.scheduleOnce(protocol.protocolId, dto);
  }

  /**
   * POST /v1/schedule/cron — Create a recurring notification via cron expression.
   */
  @Post('schedule/cron')
  @HttpCode(HttpStatus.CREATED)
  @RequiredScopes('notify:write')
  @ApiOperation({
    summary: 'Create a recurring notification via cron expression',
  })
  @ApiResponse({
    status: 201,
    description: 'Recurring scheduled notification created',
  })
  async scheduleRecurring(
    @Body() dto: ScheduleRecurringDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.schedulerService.scheduleRecurring(protocol.protocolId, dto);
  }

  /**
   * GET /v1/schedule — List scheduled notifications for the authenticated protocol.
   */
  @Get('schedule')
  @RequiredScopes('notify:read')
  @ApiOperation({ summary: 'List scheduled notifications' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of scheduled notifications',
  })
  async listScheduled(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.schedulerService.listScheduled(
      protocol.protocolId,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  /**
   * DELETE /v1/schedule/:id — Cancel a pending scheduled notification.
   */
  @Delete('schedule/:id')
  @HttpCode(HttpStatus.OK)
  @RequiredScopes('notify:write')
  @ApiOperation({ summary: 'Cancel a scheduled notification' })
  @ApiParam({ name: 'id', description: 'Scheduled notification UUID' })
  @ApiResponse({ status: 200, description: 'Cancelled' })
  async cancelScheduled(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<{ cancelled: boolean }> {
    await this.schedulerService.cancelScheduled(protocol.protocolId, id);
    return { cancelled: true };
  }

  private buildTelegramPreview(
    subject: string,
    body: string,
    category: string,
  ): string {
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

  private buildSmsPreview(
    protocolName: string,
    subject: string,
    body: string,
  ): string {
    const truncatedBody = body.length > 120 ? body.slice(0, 119) + '…' : body;
    return `[${protocolName}] ${subject}: ${truncatedBody} (via Herald)`;
  }
}

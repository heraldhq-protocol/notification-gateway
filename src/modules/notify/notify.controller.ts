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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { NotifyService } from './notify.service.js';
import {
  NotifyDto,
  NotifyBatchDto,
  NotifyResponseDto,
  NotificationStatusDto,
} from './dto/notify.dto.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { ApiKey } from '../../common/decorators/api-key.decorator.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types.js';

/**
 * NotifyController — notification send and status endpoints.
 *
 * All endpoints require Bearer authentication (API key).
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1')
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  /**
   * POST /v1/notify — Send a single notification.
   * Returns 202 Accepted with notification_id (async delivery).
   */
  @Post('notify')
  @HttpCode(HttpStatus.ACCEPTED)
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
    const results = await Promise.allSettled(
      dto.notifications.map((n) =>
        this.notifyService.queueNotification(n, protocol),
      ),
    );

    return results.map((r, i) => {
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
}

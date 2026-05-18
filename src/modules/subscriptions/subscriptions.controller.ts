import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { InternalGuard } from '../../common/guards/internal.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { SubscriptionsService } from './subscriptions.service';
import {
  SubscribeDto,
  SubscriptionStatusDto,
  SubscriberCountDto,
  InternalSubscribeDto,
} from './dto/subscription.dto';

/**
 * SubscriptionsController — manages per-protocol audience subscriptions.
 *
 * A ProtocolSubscription row represents explicit opt-in intent for a specific
 * protocol. Created when a user visits /join/:protocolId or clicks an embedded
 * "Enable Notifications" button in a protocol's frontend.
 *
 * These rows power:
 *   - Accurate audience counts before the first send
 *   - POST /v1/notify/broadcast — fan-out to all subscribers
 *   - The "isSubscribed" check in the Herald SDK widget
 */
@ApiTags('Subscriptions')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  /**
   * POST /v1/subscriptions — subscribe a wallet to this protocol.
   * Called from a protocol's backend with their API key, or from the SDK's
   * "Enable Notifications" flow if the protocol uses server-side proxying.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequiredScopes('notify:write')
  @ApiOperation({ summary: 'Subscribe a wallet to this protocol' })
  @ApiResponse({
    status: 201,
    description: 'Subscription created or reactivated',
  })
  async subscribe(
    @Body() dto: SubscribeDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const sub = await this.subscriptionsService.subscribe(
      dto.walletAddress,
      protocol.protocolId,
      dto.channels ?? ['email'],
      'api',
    );
    return {
      subscriptionId: sub.id,
      walletAddress: dto.walletAddress,
      protocolId: protocol.protocolId,
      channels: sub.channels,
      status: sub.status,
      subscribedAt: sub.subscribedAt.toISOString(),
    };
  }

  /**
   * DELETE /v1/subscriptions/:walletAddress — unsubscribe a wallet.
   */
  @Delete(':walletAddress')
  @HttpCode(HttpStatus.OK)
  @RequiredScopes('notify:write')
  @ApiOperation({ summary: 'Unsubscribe a wallet from this protocol' })
  async unsubscribe(
    @Param('walletAddress') walletAddress: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<{ success: boolean }> {
    const walletHash = this.subscriptionsService.sha256(walletAddress);
    await this.subscriptionsService.unsubscribe(
      walletHash,
      protocol.protocolId,
    );
    return { success: true };
  }

  /**
   * GET /v1/subscriptions/check — check if a wallet is subscribed.
   * Used by the Herald SDK widget to show the correct button state.
   */
  @Get('check')
  @RequiredScopes('notify:read')
  @ApiOperation({ summary: 'Check subscription status for a wallet' })
  @ApiQuery({ name: 'walletAddress', required: true })
  @ApiResponse({ status: 200, type: SubscriptionStatusDto })
  async check(
    @Query('walletAddress') walletAddress: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<SubscriptionStatusDto> {
    if (!walletAddress)
      throw new BadRequestException('walletAddress is required');
    const walletHash = this.subscriptionsService.sha256(walletAddress);
    const result = await this.subscriptionsService.checkSubscription(
      walletHash,
      protocol.protocolId,
    );
    return {
      walletAddress,
      isSubscribed: result.isSubscribed,
      channels: result.channels,
      subscribedAt: result.subscribedAt?.toISOString() ?? null,
    };
  }

  /**
   * GET /v1/subscriptions — total subscriber count for this protocol.
   */
  @Get()
  @RequiredScopes('notify:read')
  @ApiOperation({ summary: 'Get subscriber count for this protocol' })
  @ApiResponse({ status: 200, type: SubscriberCountDto })
  async count(
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<SubscriberCountDto> {
    const stats = await this.subscriptionsService.getAudienceStats(
      protocol.protocolId,
    );
    return { total: stats.totalSubscribers, byChannel: stats.byChannel };
  }
}

/**
 * InternalSubscriptionsController — called by herald-admin-registration-api
 * after a user completes the /join/:protocolId flow.
 *
 * Uses x-internal-secret header auth (InternalGuard) — never exposed publicly.
 */
@ApiTags('Internal')
@Controller('internal/subscriptions')
export class InternalSubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post()
  @UseGuards(InternalGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register protocol subscription (internal — join flow)',
  })
  async subscribeInternal(@Body() dto: InternalSubscribeDto) {
    const sub = await this.subscriptionsService.subscribe(
      dto.walletPubkey,
      dto.protocolId,
      dto.channels ?? ['email'],
      dto.source ?? 'join_link',
    );
    return { subscriptionId: sub.id, status: sub.status };
  }
}

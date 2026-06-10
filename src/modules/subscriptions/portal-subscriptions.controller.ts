import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { PortalAuthGuard } from '../../common/guards/portal-auth.guard';
import { SubscriptionsService } from './subscriptions.service';

type AuthedRequest = Request & { walletHash: string };

/**
 * PortalSubscriptionsController — lets portal users view and manage
 * their own protocol subscriptions.
 *
 * Auth: PortalAuthGuard (session-based JWT introspection).
 * Identity: walletHash attached to request by the guard.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@UseGuards(PortalAuthGuard)
@Controller('v1/portal/subscriptions')
export class PortalSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  /**
   * GET /v1/portal/subscriptions
   * Returns all protocol subscriptions for the authenticated user,
   * including unsubscribed ones so they can be re-enabled.
   */
  @Get()
  @ApiOperation({ summary: "List user's protocol subscriptions" })
  @ApiResponse({ status: 200, description: 'Subscription list returned' })
  async list(@Req() req: AuthedRequest) {
    return this.subscriptions.getUserSubscriptions(req.walletHash);
  }

  /**
   * DELETE /v1/portal/subscriptions/:protocolId
   * Unsubscribe the authenticated user from a specific protocol.
   */
  @Delete(':protocolId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unsubscribe from a protocol' })
  @ApiResponse({ status: 200, description: 'Unsubscribed successfully' })
  async unsubscribe(
    @Req() req: AuthedRequest,
    @Param('protocolId') protocolId: string,
  ) {
    await this.subscriptions.unsubscribe(req.walletHash, protocolId);
    return { success: true };
  }

  /**
   * POST /v1/portal/subscriptions/:protocolId/resubscribe
   * Re-activate a previously unsubscribed protocol.
   */
  @Post(':protocolId/resubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-subscribe to a protocol' })
  @ApiResponse({ status: 200, description: 'Resubscribed successfully' })
  async resubscribe(
    @Req() req: AuthedRequest,
    @Param('protocolId') protocolId: string,
  ) {
    await this.subscriptions.resubscribe(req.walletHash, protocolId);
    return { success: true };
  }
}

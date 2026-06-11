import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
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
import { PrismaService } from '../../database/prisma.service';

class UpdateProtocolPreferencesDto {
  optInDefi?: boolean | null;
  optInGovernance?: boolean | null;
  optInMarketing?: boolean | null;
  optInSystem?: boolean | null;
  channels?: string[];
}

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
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly prisma: PrismaService,
  ) {}

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
   * POST /v1/portal/subscriptions/:protocolId
   * Subscribe (or re-activate) the authenticated user to a protocol.
   * Creates a new row if none exists, otherwise sets status → active.
   */
  @Post(':protocolId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Subscribe to a protocol (portal-initiated)' })
  @ApiResponse({ status: 200, description: 'Subscribed successfully' })
  async subscribe(
    @Req() req: AuthedRequest,
    @Param('protocolId') protocolId: string,
  ) {
    await this.prisma.protocolSubscription.upsert({
      where: {
        walletHash_protocolId: {
          walletHash: req.walletHash,
          protocolId,
        },
      },
      create: {
        walletHash: req.walletHash,
        protocolId,
        status: 'active',
        channels: [],
      },
      update: {
        status: 'active',
      },
    });
    return { success: true };
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

  /**
   * GET /v1/portal/subscriptions/:protocolId/preferences
   * Returns per-protocol category + channel overrides for the user.
   * Null values mean "inherit from global preferences".
   */
  @Get(':protocolId/preferences')
  @ApiOperation({ summary: 'Get per-protocol notification preferences' })
  @ApiResponse({ status: 200 })
  async getPreferences(
    @Req() req: AuthedRequest,
    @Param('protocolId') protocolId: string,
  ) {
    const pref = await this.prisma.userProtocolPreference.findUnique({
      where: {
        walletHash_protocolId: {
          walletHash: req.walletHash,
          protocolId,
        },
      },
    });

    return {
      protocolId,
      optInDefi: pref?.optInDefi ?? null,
      optInGovernance: pref?.optInGovernance ?? null,
      optInMarketing: pref?.optInMarketing ?? null,
      optInSystem: pref?.optInSystem ?? null,
      channels: pref?.channels ?? [],
    };
  }

  /**
   * PUT /v1/portal/subscriptions/:protocolId/preferences
   * Upserts per-protocol category + channel overrides.
   * Pass null for a category to revert to global preference.
   */
  @Put(':protocolId/preferences')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update per-protocol notification preferences' })
  @ApiResponse({ status: 200 })
  async updatePreferences(
    @Req() req: AuthedRequest,
    @Param('protocolId') protocolId: string,
    @Body() dto: UpdateProtocolPreferencesDto,
  ) {
    const pref = await this.prisma.userProtocolPreference.upsert({
      where: {
        walletHash_protocolId: {
          walletHash: req.walletHash,
          protocolId,
        },
      },
      create: {
        walletHash: req.walletHash,
        protocolId,
        optInDefi: dto.optInDefi ?? null,
        optInGovernance: dto.optInGovernance ?? null,
        optInMarketing: dto.optInMarketing ?? null,
        optInSystem: dto.optInSystem ?? null,
        channels: dto.channels ?? [],
      },
      update: {
        ...(dto.optInDefi !== undefined && { optInDefi: dto.optInDefi }),
        ...(dto.optInGovernance !== undefined && { optInGovernance: dto.optInGovernance }),
        ...(dto.optInMarketing !== undefined && { optInMarketing: dto.optInMarketing }),
        ...(dto.optInSystem !== undefined && { optInSystem: dto.optInSystem }),
        ...(dto.channels !== undefined && { channels: dto.channels }),
      },
    });

    return {
      protocolId: pref.protocolId,
      optInDefi: pref.optInDefi,
      optInGovernance: pref.optInGovernance,
      optInMarketing: pref.optInMarketing,
      optInSystem: pref.optInSystem,
      channels: pref.channels,
    };
  }
}

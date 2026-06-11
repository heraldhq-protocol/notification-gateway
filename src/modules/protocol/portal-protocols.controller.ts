import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { PortalAuthGuard } from '../../common/guards/portal-auth.guard';
import { PrismaService } from '../../database/prisma.service';

type AuthedRequest = Request & { walletHash: string };

/**
 * PortalProtocolsController — protocol discovery for the user portal.
 *
 * Returns all active, non-suspended protocols with public metadata so
 * users can browse and subscribe from the /discover page.
 * Includes `isSubscribed` so the portal can show the correct button state.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@UseGuards(PortalAuthGuard)
@Controller('v1/portal/protocols')
export class PortalProtocolsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Discover Herald-integrated protocols' })
  async discover(@Req() req: AuthedRequest) {
    const [protocols, subscriptions] = await Promise.all([
      this.prisma.protocol.findMany({
        where: {
          isActive: true,
          isSuspended: false,
          deletedAt: null,
        },
        select: {
          id: true,
          settings: {
            select: {
              customFromName: true,
              logoUrl: true,
              websiteUrl: true,
              notificationCategories: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.protocolSubscription.findMany({
        where: { walletHash: req.walletHash, status: 'active' },
        select: { protocolId: true },
      }),
    ]);

    const subscribedIds = new Set(subscriptions.map((s) => s.protocolId));

    return protocols
      .filter((p) => p.settings?.customFromName) // only show protocols with a display name
      .map((p) => ({
        protocolId: p.id,
        name: p.settings!.customFromName!,
        logoUrl: p.settings?.logoUrl ?? null,
        websiteUrl: p.settings?.websiteUrl ?? null,
        categories: p.settings?.notificationCategories ?? [],
        isSubscribed: subscribedIds.has(p.id),
      }));
  }
}

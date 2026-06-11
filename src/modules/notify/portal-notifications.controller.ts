import {
  Controller,
  Get,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { PortalAuthGuard } from '../../common/guards/portal-auth.guard';
import { PrismaService } from '../../database/prisma.service';

type AuthedRequest = Request & { walletHash: string };

const NOTIFICATION_SELECT = {
  id: true,
  protocolId: true,
  walletHash: true,
  status: true,
  category: true,
  queuedAt: true,
  deliveredAt: true,
  receiptTx: true,
  bounce: true,
  errorCode: true,
  ciphertext: true,
  nonce: true,
} as const;

/**
 * PortalNotificationsController — returns a user's notification history.
 *
 * Fixes the live gap: the portal calls GET /v1/portal/notifications but no
 * such endpoint previously existed in the gateway.
 *
 * Also returns a `protocols` map so the portal can display protocol names
 * instead of raw UUIDs in the notification list headers.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@UseGuards(PortalAuthGuard)
@Controller('v1/portal/notifications')
export class PortalNotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "List user's notification history" })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'protocolId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'before', required: false, description: 'Cursor: notification id' })
  async list(
    @Req() req: AuthedRequest,
    @Query('category') category?: string,
    @Query('protocolId') protocolId?: string,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('before') before?: string,
  ) {
    const limit = Math.min(parseInt(limitStr ?? '100', 10) || 100, 200);

    const notifications = await this.prisma.notification.findMany({
      where: {
        walletHash: req.walletHash,
        ...(category ? { category } : {}),
        ...(protocolId ? { protocolId } : {}),
        ...(status ? { status } : {}),
      },
      select: NOTIFICATION_SELECT,
      orderBy: { queuedAt: 'desc' },
      take: limit,
      ...(before
        ? { cursor: { id: before }, skip: 1 }
        : {}),
    });

    // Fetch protocol metadata for all unique protocols in the result set
    const protocolIds = [...new Set(notifications.map((n) => n.protocolId))];
    const protocols = protocolIds.length
      ? await this.prisma.protocol.findMany({
          where: { id: { in: protocolIds } },
          select: {
            id: true,
            settings: {
              select: {
                customFromName: true,
                logoUrl: true,
                websiteUrl: true,
              },
            },
          },
        })
      : [];

    const protocolMap = Object.fromEntries(
      protocols.map((p) => [
        p.id,
        {
          name: p.settings?.customFromName ?? null,
          logoUrl: p.settings?.logoUrl ?? null,
          websiteUrl: p.settings?.websiteUrl ?? null,
        },
      ]),
    );

    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        protocolId: n.protocolId,
        walletHash: n.walletHash,
        status: n.status,
        category: n.category,
        queuedAt: n.queuedAt.toISOString(),
        deliveredAt: n.deliveredAt?.toISOString() ?? null,
        receiptTx: n.receiptTx ?? null,
        bounce: n.bounce,
        errorCode: n.errorCode ?? null,
        ciphertext: n.ciphertext ?? null,
        nonce: n.nonce ?? null,
      })),
      protocols: protocolMap,
    };
  }
}

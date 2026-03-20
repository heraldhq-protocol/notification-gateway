import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { ApiKey } from '../../common/decorators/api-key.decorator.js';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types.js';

/**
 * ProtocolController — protocol self-service endpoints.
 */
@ApiTags('Protocol')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/protocols')
export class ProtocolController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get your protocol info + subscription status' })
  async getMe(@ApiKey() protocol: AuthenticatedProtocol) {
    const p = await this.prisma.protocol.findUnique({
      where: { id: protocol.protocolId },
      include: {
        _count: {
          select: { apiKeys: true, webhooks: true, notifications: true },
        },
      },
    });

    if (!p) return { error: 'Protocol not found' };

    return {
      id: p.id,
      protocol_pubkey: p.protocolPubkey,
      tier: p.tier,
      tier_name:
        ['Developer', 'Growth', 'Scale', 'Enterprise'][p.tier] ?? 'Developer',
      is_active: p.isActive,
      is_suspended: p.isSuspended,
      sends_this_period: Number(p.sendsThisPeriod),
      period_reset_at: p.periodResetAt.toISOString(),
      subscription_expires_at: p.subscriptionExpiresAt?.toISOString() ?? null,
      counts: {
        api_keys: p._count.apiKeys,
        webhooks: p._count.webhooks,
        notifications: p._count.notifications,
      },
      created_at: p.createdAt.toISOString(),
    };
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { ApiKey } from '../../common/decorators/api-key.decorator.js';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types.js';

/**
 * AnalyticsController — delivery analytics and usage stats.
 */
@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1')
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Get delivery analytics overview' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['7d', '30d', '90d'],
    description: 'Analytics period',
  })
  async getAnalytics(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('period') period: '7d' | '30d' | '90d' = '30d',
  ) {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period];
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, delivered, failed, optedOut, bounced] = await Promise.all([
      this.prisma.notification.count({
        where: { protocolId: protocol.protocolId, queuedAt: { gte: since } },
      }),
      this.prisma.notification.count({
        where: {
          protocolId: protocol.protocolId,
          status: 'delivered',
          queuedAt: { gte: since },
        },
      }),
      this.prisma.notification.count({
        where: {
          protocolId: protocol.protocolId,
          status: 'failed',
          queuedAt: { gte: since },
        },
      }),
      this.prisma.notification.count({
        where: {
          protocolId: protocol.protocolId,
          status: 'opted_out',
          queuedAt: { gte: since },
        },
      }),
      this.prisma.notification.count({
        where: {
          protocolId: protocol.protocolId,
          bounce: true,
          queuedAt: { gte: since },
        },
      }),
    ]);

    return {
      period,
      total_sends: total,
      delivery_rate: total > 0 ? delivered / total : 0,
      bounce_rate: total > 0 ? bounced / total : 0,
      opted_out_rate: total > 0 ? optedOut / total : 0,
      failure_rate: total > 0 ? failed / total : 0,
      breakdown: { delivered, failed, opted_out: optedOut, bounced },
    };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Current period usage vs quota' })
  async getUsage(@ApiKey() protocol: AuthenticatedProtocol) {
    const p = await this.prisma.protocol.findUnique({
      where: { id: protocol.protocolId },
    });

    const tierLimits: Record<number, number> = {
      0: 1_000,
      1: 50_000,
      2: 250_000,
      3: 1_000_000,
    };

    const limit = tierLimits[protocol.tier] ?? 1000;
    const used = Number(p?.sendsThisPeriod ?? 0);

    return {
      tier: protocol.tier,
      tier_name:
        ['Developer', 'Growth', 'Scale', 'Enterprise'][protocol.tier] ??
        'Developer',
      sends_used: used,
      sends_limit: limit,
      sends_remaining: Math.max(0, limit - used),
      usage_pct: limit > 0 ? (used / limit) * 100 : 0,
      period_reset_at: p?.periodResetAt?.toISOString() ?? null,
    };
  }
}

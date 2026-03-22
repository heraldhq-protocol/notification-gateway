import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AnalyticsService {
    constructor(private readonly prisma: PrismaService) { }

    async getAnalytics(protocolId: string, period: '7d' | '30d' | '90d' = '30d') {
        const days = { '7d': 7, '30d': 30, '90d': 90 }[period];
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const [total, delivered, failed, optedOut, bounced] = await Promise.all([
            this.prisma.notification.count({
                where: { protocolId, queuedAt: { gte: since } },
            }),
            this.prisma.notification.count({
                where: {
                    protocolId,
                    status: 'delivered',
                    queuedAt: { gte: since },
                },
            }),
            this.prisma.notification.count({
                where: {
                    protocolId,
                    status: 'failed',
                    queuedAt: { gte: since },
                },
            }),
            this.prisma.notification.count({
                where: {
                    protocolId,
                    status: 'opted_out',
                    queuedAt: { gte: since },
                },
            }),
            this.prisma.notification.count({
                where: {
                    protocolId,
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

    async getUsage(protocolId: string, tier: number) {
        const p = await this.prisma.protocol.findUnique({
            where: { id: protocolId },
        });

        const tierLimits: Record<number, number> = {
            0: 1_000,
            1: 50_000,
            2: 250_000,
            3: 1_000_000,
        };

        const limit = tierLimits[tier] ?? 1000;
        const used = Number(p?.sendsThisPeriod ?? 0);

        return {
            tier,
            tier_name: ['Developer', 'Growth', 'Scale', 'Enterprise'][tier] ?? 'Developer',
            sends_used: used,
            sends_limit: limit,
            sends_remaining: Math.max(0, limit - used),
            usage_pct: limit > 0 ? (used / limit) * 100 : 0,
            period_reset_at: p?.periodResetAt?.toISOString() ?? null,
        };
    }
}

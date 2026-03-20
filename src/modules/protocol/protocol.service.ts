import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class ProtocolService {
    constructor(private readonly prisma: PrismaService) { }

    async getProtocolInfo(protocolId: string) {
        const p = await this.prisma.protocol.findUnique({
            where: { id: protocolId },
            include: {
                _count: {
                    select: { apiKeys: true, webhooks: true, notifications: true },
                },
            },
        });

        if (!p) return null;

        return {
            id: p.id,
            protocol_pubkey: p.protocolPubkey,
            tier: p.tier,
            tier_name: ['Developer', 'Growth', 'Scale', 'Enterprise'][p.tier] ?? 'Developer',
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

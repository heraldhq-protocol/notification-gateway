import { Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { PaymentRepository } from './repositories/payment.repository';
import { HelioService } from './helio/helio.service';
import { ProtocolService } from '../protocol/protocol.service';

export const TIER_SEND_LIMITS: Record<number, number> = {
    0: 1_000,
    1: 10_000,
    2: 100_000,
    3: 1_000_000, // Or unlimited, using a very high number
};

@Injectable()
export class BillingService {
    constructor(
        private readonly subscriptionRepo: SubscriptionRepository,
        private readonly paymentRepo: PaymentRepository,
        private readonly protocolService: ProtocolService,
        private readonly helioService: HelioService,
    ) { }

    async getStatus(protocolId: string) {
        const protocol = await this.protocolService.findById(protocolId);
        if (!protocol) throw new NotFoundException('Protocol not found');

        const subscription = await this.subscriptionRepo.findByProtocolId(protocolId);

        const sendsLimit = TIER_SEND_LIMITS[protocol.tier] || 1000;
        const sendsThisPeriod = Number(subscription?.sendsThisPeriod ?? protocol.sendsThisPeriod);

        return {
            tier: protocol.tier,
            tierName: ['Developer', 'Growth', 'Scale', 'Enterprise'][protocol.tier],
            isActive: protocol.isActive,
            status: subscription?.status ?? 'inactive',
            expiresAt: subscription?.currentPeriodEnd ?? null,
            daysRemaining: subscription?.currentPeriodEnd ? Math.max(0, Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / 86400000)) : 0,
            sendsThisPeriod,
            sendsLimit,
            usagePercent: Math.min(100, (sendsThisPeriod / sendsLimit) * 100),
            periodResetAt: subscription?.periodResetAt ?? protocol.periodResetAt,
            cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        };
    }

    async getPaymentHistory(protocolId: string, pagination: { page?: number, limit?: number }) {
        const page = pagination.page ?? 1;
        const limit = pagination.limit ?? 50;
        const skip = (page - 1) * limit;

        const [payments, total] = await this.paymentRepo.findByProtocolId(protocolId, skip, limit);
        return {
            payments,
            total,
            page,
            limit,
        };
    }

    getAllTierInfo() {
        return [
            { tier: 0, name: 'Developer', priceUsdc: 0, limit: TIER_SEND_LIMITS[0] },
            { tier: 1, name: 'Growth', priceUsdc: 99, limit: TIER_SEND_LIMITS[1] },
            { tier: 2, name: 'Scale', priceUsdc: 299, limit: TIER_SEND_LIMITS[2] },
            { tier: 3, name: 'Enterprise', priceUsdc: 999, limit: TIER_SEND_LIMITS[3] },
        ];
    }

    async getUsageStats(protocolId: string) {
        const status = await this.getStatus(protocolId);
        return {
            sendsThisPeriod: status.sendsThisPeriod,
            sendsLimit: status.sendsLimit,
            sendsRemaining: Math.max(0, status.sendsLimit - status.sendsThisPeriod),
            usagePercent: status.usagePercent,
            periodResetAt: status.periodResetAt,
        };
    }
}

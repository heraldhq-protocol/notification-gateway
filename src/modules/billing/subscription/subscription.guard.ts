import {
    Injectable,
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { HelioService } from '../helio/helio.service';
import { TIER_SEND_LIMITS } from '../billing.service';

export class PaymentRequiredException extends HttpException {
    constructor(data: Record<string, unknown>) {
        super(data, HttpStatus.PAYMENT_REQUIRED);
    }
}

export class QuotaExceededException extends HttpException {
    constructor(data: Record<string, unknown>) {
        super(data, HttpStatus.TOO_MANY_REQUESTS);
    }
}

@Injectable()
export class SubscriptionGuard implements CanActivate {
    constructor(
        private readonly subscriptionRepo: SubscriptionRepository,
        private readonly helioService: HelioService,
    ) { }

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest();
        const protocol = req.protocol; // Assuming AuthenticatedRequest attaches Protocol

        if (!protocol) return true; // Let AuthGuard handle unauthorized

        const subscription = await this.subscriptionRepo.findByProtocolId(protocol.id);

        // Dev tier (0) is free
        if (protocol.tier === 0) return true;

        if (!subscription || subscription.status !== 'active') {
            throw new PaymentRequiredException({
                error: 'SUBSCRIPTION_INACTIVE',
                message: 'Subscribe to start sending notifications.',
                checkoutUrl: await this.getCheckoutUrl(protocol),
            });
        }

        if (subscription.currentPeriodEnd && subscription.currentPeriodEnd < new Date()) {
            throw new PaymentRequiredException({
                error: 'SUBSCRIPTION_EXPIRED',
                message: 'Your subscription has expired. Renew to continue sending.',
                expiredAt: subscription.currentPeriodEnd.toISOString(),
                checkoutUrl: await this.getCheckoutUrl(protocol),
            });
        }

        const tierLimits = TIER_SEND_LIMITS[protocol.tier] || 1000;
        if (Number(subscription.sendsThisPeriod) >= tierLimits) {
            throw new QuotaExceededException({
                error: 'QUOTA_EXCEEDED',
                message: `Monthly send limit reached (${tierLimits.toLocaleString()} sends).`,
                sendsUsed: Number(subscription.sendsThisPeriod),
                sendsLimit: tierLimits,
                periodResetAt: subscription.periodResetAt.toISOString(),
                upgradeUrl: 'https://app.herald.xyz/billing/upgrade',
            });
        }

        return true;
    }

    private async getCheckoutUrl(protocol: any): Promise<string> {
        try {
            const result = await this.helioService.createCheckoutUrl(
                protocol,
                protocol.tier > 0 ? protocol.tier : 1,
            );
            return result.checkoutUrl;
        } catch {
            return 'https://app.herald.xyz/billing';
        }
    }
}

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
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
  private static readonly CACHE_TTL = 30;
  private static readonly CACHE_PREFIX = 'sub:';

  constructor(
    private readonly subscriptionRepo: SubscriptionRepository,
    private readonly helioService: HelioService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const protocol = req.authProtocol; // Set by AuthGuard

    if (!protocol) return true; // Let AuthGuard handle unauthorized

    // Dev tier (0) is free — skip Prisma query entirely
    if (protocol.tier === 0) return true;

    // Cache-first: Redis hit avoids Prisma pool wait
    const cacheKey = `${SubscriptionGuard.CACHE_PREFIX}${protocol.protocolId}`;
    let subscription: import('../../../../prisma/generated/prisma/index').Subscription | null = null;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        subscription = JSON.parse(cached, (_k, v) =>
          typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)
            ? new Date(v)
            : v,
        ) as typeof subscription;
      }
    } catch {
      // Cache miss → fall through to Prisma
    }

    if (!subscription) {
      subscription = await this.subscriptionRepo.findByProtocolId(
        protocol.protocolId,
      );
      if (subscription) {
        this.redis
          .setex(cacheKey, SubscriptionGuard.CACHE_TTL, JSON.stringify(subscription, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          ))
          .catch(() => {});
      }
    }

    if (!subscription || subscription.status !== 'active') {
      throw new PaymentRequiredException({
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Subscribe to start sending notifications.',
        checkoutUrl: await this.getCheckoutUrl(protocol),
      });
    }

    if (
      subscription.currentPeriodEnd &&
      subscription.currentPeriodEnd < new Date()
    ) {
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
        upgradeUrl: 'https://app.useherald.xyz/billing/upgrade',
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
      return 'https://app.useherald.xyz/billing';
    }
  }
}

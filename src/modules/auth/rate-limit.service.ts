import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type {
  TierLimit,
  RateLimitResult,
  AuthenticatedProtocol,
} from '../../common/types/protocol.types.js';

/**
 * RateLimitService — sliding window rate limiting using Redis ZADD.
 *
 * Tier limits (from SRS GW-F-009):
 *   Developer:    2 req/s  | burst 10   | monthly 1,000
 *   Growth:      20 req/s  | burst 100  | monthly 50,000
 *   Scale:      100 req/s  | burst 500  | monthly 250,000
 *   Enterprise: 500 req/s  | burst 2000 | monthly 1,000,000
 */
@Injectable()
export class RateLimitService {
  private static readonly TIER_LIMITS: Record<number, TierLimit> = {
    0: { perSecond: 2, burst: 10, monthly: 1_000 },
    1: { perSecond: 20, burst: 100, monthly: 50_000 },
    2: { perSecond: 100, burst: 500, monthly: 250_000 },
    3: { perSecond: 500, burst: 2000, monthly: 1_000_000 },
  };

  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: Redis) {}

  /**
   * Check and increment the sliding window counter.
   * Uses Redis ZADD with timestamps as scores for precise sliding window.
   */
  async checkAndIncrement(
    protocolId: string,
    tier: number,
  ): Promise<RateLimitResult> {
    const limit =
      RateLimitService.TIER_LIMITS[tier] ?? RateLimitService.TIER_LIMITS[0]!;
    const now = Date.now();
    const window = 1000; // 1 second sliding window
    const key = `rl:${protocolId}`;

    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(key, 0, now - window);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.expire(key, 2);

    const results = await pipeline.exec();
    if (!results) {
      return {
        allowed: true,
        limit: limit.burst,
        remaining: limit.burst,
        resetAt: 0,
      };
    }

    const requestsInWindow = (results[2]?.[1] as number) ?? 0;
    const remaining = Math.max(0, limit.burst - requestsInWindow);
    const reset = Math.ceil((now + window) / 1000);

    if (requestsInWindow > limit.burst) {
      return {
        allowed: false,
        limit: limit.burst,
        remaining: 0,
        resetAt: reset,
        retryAfter: 1,
      };
    }

    return { allowed: true, limit: limit.burst, remaining, resetAt: reset };
  }

  /** Check monthly quota against protocol's sends_this_period. */
  checkMonthlyQuota(tier: number, sendsThisPeriod: bigint): boolean {
    const limit = RateLimitService.TIER_LIMITS[tier]?.monthly ?? 1000;
    return Number(sendsThisPeriod) < limit;
  }

  /** Get tier limits for display. */
  getTierLimits(tier: number): TierLimit {
    return (
      RateLimitService.TIER_LIMITS[tier] ?? RateLimitService.TIER_LIMITS[0]!
    );
  }
}

import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../modules/redis/redis.module';
import { PrismaService } from '../../../database/prisma.service';
import {
  Prisma,
  Subscription,
} from '../../../../prisma/generated/prisma/index';

const CACHE_PREFIX = 'sub:';

@Injectable()
export class SubscriptionRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async findByProtocolId(protocolId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({
      where: { protocolId },
    });
  }

  async update(
    protocolId: string,
    data: Prisma.SubscriptionUpdateInput,
  ): Promise<Subscription> {
    const result = await this.prisma.subscription.update({
      where: { protocolId },
      data,
    });
    this.redis.del(`${CACHE_PREFIX}${protocolId}`).catch(() => {});
    return result;
  }

  async upsert(
    protocolId: string,
    data:
      | Prisma.SubscriptionCreateInput
      | Prisma.SubscriptionUncheckedCreateInput,
  ): Promise<Subscription> {
    const result = await this.prisma.subscription.upsert({
      where: { protocolId },
      create: data as Prisma.SubscriptionUncheckedCreateInput,
      update: data,
    });
    this.redis.del(`${CACHE_PREFIX}${protocolId}`).catch(() => {});
    return result;
  }

  async findExpired(): Promise<
    (Subscription & { protocol: { protocolPubkey: string } })[]
  > {
    return this.prisma.subscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: { lt: new Date() },
      },
      include: {
        protocol: { select: { protocolPubkey: true } },
      },
    });
  }

  async findDueForReset(): Promise<
    (Subscription & { protocol: { protocolPubkey: string } })[]
  > {
    return this.prisma.subscription.findMany({
      where: {
        status: 'active',
        periodResetAt: { lt: new Date() },
      },
      include: {
        protocol: { select: { protocolPubkey: true } },
      },
    });
  }

  async resetSends(protocolId: string): Promise<Subscription> {
    const nextReset = new Date();
    nextReset.setDate(nextReset.getDate() + 30);
    const result = await this.prisma.subscription.update({
      where: { protocolId },
      data: {
        sendsThisPeriod: 0,
        periodResetAt: nextReset,
      },
    });
    this.redis.del(`${CACHE_PREFIX}${protocolId}`).catch(() => {});
    return result;
  }

  // Not implementing complex findNearQuota and findExpiringSoon entirely within DB if they rely on varying thresholds,
  // but we can fetch active subscriptions and filter in service or do a raw query.
  async findActive(): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { status: 'active' },
    });
  }
}

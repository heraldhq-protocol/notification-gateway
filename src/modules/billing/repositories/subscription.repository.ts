import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import {
  Prisma,
  Subscription,
} from '../../../../prisma/generated/prisma/index';

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProtocolId(protocolId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({
      where: { protocolId },
    });
  }

  async update(
    protocolId: string,
    data: Prisma.SubscriptionUpdateInput,
  ): Promise<Subscription> {
    return this.prisma.subscription.update({
      where: { protocolId },
      data,
    });
  }

  async upsert(
    protocolId: string,
    data:
      | Prisma.SubscriptionCreateInput
      | Prisma.SubscriptionUncheckedCreateInput,
  ): Promise<Subscription> {
    return this.prisma.subscription.upsert({
      where: { protocolId },
      create: data as Prisma.SubscriptionUncheckedCreateInput,
      update: data as Prisma.SubscriptionUncheckedUpdateInput,
    });
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
    return this.prisma.subscription.update({
      where: { protocolId },
      data: {
        sendsThisPeriod: 0,
        periodResetAt: nextReset,
      },
    });
  }

  // Not implementing complex findNearQuota and findExpiringSoon entirely within DB if they rely on varying thresholds,
  // but we can fetch active subscriptions and filter in service or do a raw query.
  async findActive(): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { status: 'active' },
    });
  }
}

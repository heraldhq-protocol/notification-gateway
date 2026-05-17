import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async subscribe(
    walletPubkey: string,
    protocolId: string,
    channels: string[] = ['email'],
    source: string = 'sdk',
  ) {
    const walletHash = this.sha256(walletPubkey);
    return this.prisma.protocolSubscription.upsert({
      where: { walletHash_protocolId: { walletHash, protocolId } },
      create: { walletPubkey, walletHash, protocolId, channels, status: 'active', source },
      update: { status: 'active', channels, walletPubkey, updatedAt: new Date() },
    });
  }

  async unsubscribe(walletHash: string, protocolId: string): Promise<void> {
    await this.prisma.protocolSubscription.updateMany({
      where: { walletHash, protocolId },
      data: { status: 'unsubscribed' },
    });
  }

  async checkSubscription(
    walletHash: string,
    protocolId: string,
  ): Promise<{ isSubscribed: boolean; channels: string[]; subscribedAt: Date | null }> {
    const sub = await this.prisma.protocolSubscription.findUnique({
      where: { walletHash_protocolId: { walletHash, protocolId } },
    });
    return {
      isSubscribed: sub?.status === 'active',
      channels: sub?.channels ?? [],
      subscribedAt: sub?.subscribedAt ?? null,
    };
  }

  async getSubscriberCount(protocolId: string): Promise<number> {
    return this.prisma.protocolSubscription.count({
      where: { protocolId, status: 'active' },
    });
  }

  /** Returns subscribers that have a known walletPubkey — usable for broadcast targeting. */
  async getBroadcastTargets(
    protocolId: string,
  ): Promise<{ walletPubkey: string; walletHash: string; channels: string[] }[]> {
    const rows = await this.prisma.protocolSubscription.findMany({
      where: { protocolId, status: 'active', walletPubkey: { not: null } },
      select: { walletPubkey: true, walletHash: true, channels: true },
    });
    return rows.filter((r) => r.walletPubkey !== null) as {
      walletPubkey: string;
      walletHash: string;
      channels: string[];
    }[];
  }

  /** Audience stats for analytics endpoint. */
  async getAudienceStats(protocolId: string): Promise<{
    totalSubscribers: number;
    broadcastableSubscribers: number;
    bySource: Record<string, number>;
    byChannel: Record<string, number>;
    recentSubscriptions: { date: string; count: number }[];
  }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [total, broadcastable, allActive] = await Promise.all([
      this.prisma.protocolSubscription.count({
        where: { protocolId, status: 'active' },
      }),
      this.prisma.protocolSubscription.count({
        where: { protocolId, status: 'active', walletPubkey: { not: null } },
      }),
      this.prisma.protocolSubscription.findMany({
        where: { protocolId, status: 'active' },
        select: { source: true, channels: true, subscribedAt: true },
      }),
    ]);

    const bySource: Record<string, number> = {};
    const channelCount: Record<string, number> = {};
    const byDay: Record<string, number> = {};

    for (const row of allActive) {
      bySource[row.source] = (bySource[row.source] ?? 0) + 1;
      for (const ch of row.channels) {
        channelCount[ch] = (channelCount[ch] ?? 0) + 1;
      }
      if (row.subscribedAt >= thirtyDaysAgo) {
        const day = row.subscribedAt.toISOString().slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + 1;
      }
    }

    const recentSubscriptions = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return { totalSubscribers: total, broadcastableSubscribers: broadcastable, bySource, byChannel: channelCount, recentSubscriptions };
  }

  sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}

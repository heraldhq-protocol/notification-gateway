import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

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
      tier_name:
        ['Developer', 'Growth', 'Scale', 'Enterprise'][tier] ?? 'Developer',
      sends_used: used,
      sends_limit: limit,
      sends_remaining: Math.max(0, limit - used),
      usage_pct: limit > 0 ? (used / limit) * 100 : 0,
      period_reset_at: p?.periodResetAt?.toISOString() ?? null,
    };
  }

  async getEngagementMetrics(
    protocolId: string,
    startDate?: string,
    endDate?: string,
    _templateId?: string,
  ) {
    const since = startDate
      ? new Date(startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = endDate ? new Date(endDate) : new Date();

    const where = {
      protocolId,
      createdAt: { gte: since, lte: until },
    };

    const [opens, clicks, unsubs, totalSends] = await Promise.all([
      this.prisma.notificationEngagement.count({
        where: { ...where, eventType: 'open' },
      }),
      this.prisma.notificationEngagement.count({
        where: { ...where, eventType: 'click' },
      }),
      this.prisma.notificationEngagement.count({
        where: { ...where, eventType: 'unsubscribe' },
      }),
      // Count only notifications that had tracking enabled at send time.
      // This prevents untracked historical sends from diluting the rates.
      this.prisma.notification.count({
        where: {
          protocolId,
          queuedAt: { gte: since, lte: until },
          trackingEnabled: true,
        },
      }),
    ]);

    const safeRate = (n: number) =>
      totalSends > 0 ? +((n / totalSends) * 100).toFixed(2) : 0;

    return {
      totalSends,
      opens,
      clicks,
      unsubscribes: unsubs,
      openRate: safeRate(opens),
      clickRate: safeRate(clicks),
      unsubscribeRate: safeRate(unsubs),
      period: { from: since.toISOString(), to: until.toISOString() },
    };
  }

  async recordEngagement(
    notificationId: string,
    protocolId: string,
    eventType: 'open' | 'click' | 'unsubscribe',
    linkUrl?: string,
    userAgentHash?: string,
  ) {
    await this.prisma.notificationEngagement.create({
      data: {
        notificationId,
        protocolId,
        eventType,
        linkUrl,
        userAgentHash,
      },
    });
  }

  async getRequestLogs(
    protocolId: string,
    filters: {
      page: number;
      limit: number;
      statusCode?: number;
      endpoint?: string;
      isTestKey?: boolean;
    },
  ) {
    const { page, limit, statusCode, endpoint, isTestKey } = filters;
    const skip = (page - 1) * limit;

    const where = {
      protocolId,
      ...(statusCode !== undefined && { statusCode }),
      ...(endpoint !== undefined && { endpoint: { contains: endpoint } }),
      ...(isTestKey !== undefined && { isTestKey }),
    };

    const [items, total] = await Promise.all([
      this.prisma.apiRequestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          apiKeyId: true,
          isTestKey: true,
          method: true,
          endpoint: true,
          requestBody: true,
          responseBody: true,
          statusCode: true,
          latencyMs: true,
          correlationId: true,
          createdAt: true,
        },
      }),
      this.prisma.apiRequestLog.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      hasMore: skip + items.length < total,
    };
  }

  /**
   * Audience analytics — combines subscription table data with
   * notification delivery history for a full picture.
   */
  async getAudienceAnalytics(protocolId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [subStats, recentlyNotified, registrationTrend] = await Promise.all([
      this.subscriptionsService.getAudienceStats(protocolId),
      // Distinct wallets that received a notification in the last 30 days
      this.prisma.notification.findMany({
        where: {
          protocolId,
          status: { in: ['delivered', 'partial'] },
          queuedAt: { gte: thirtyDaysAgo },
        },
        select: { walletHash: true },
        distinct: ['walletHash'],
      }),
      // Daily subscription counts for the last 90 days
      this.prisma.protocolSubscription.findMany({
        where: { protocolId, subscribedAt: { gte: ninetyDaysAgo } },
        select: { subscribedAt: true },
        orderBy: { subscribedAt: 'asc' },
      }),
    ]);

    // Build daily registration trend
    const trendMap: Record<string, number> = {};
    for (const row of registrationTrend) {
      const day = row.subscribedAt.toISOString().slice(0, 10);
      trendMap[day] = (trendMap[day] ?? 0) + 1;
    }
    const trend = Object.entries(trendMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    const total = subStats.totalSubscribers;
    const activeCount = recentlyNotified.length;
    const retentionRate =
      total > 0 ? Math.round((activeCount / total) * 100) : 0;

    const emailCount = subStats.byChannel['email'] ?? 0;
    const telegramCount = subStats.byChannel['telegram'] ?? 0;
    const smsCount = subStats.byChannel['sms'] ?? 0;

    return {
      totalRegistered: total,
      broadcastableSubscribers: subStats.broadcastableSubscribers,
      activeLastThirtyDays: activeCount,
      retentionRate,
      channelCoverage: {
        email: total > 0 ? Math.round((emailCount / total) * 100) : 0,
        telegram: total > 0 ? Math.round((telegramCount / total) * 100) : 0,
        sms: total > 0 ? Math.round((smsCount / total) * 100) : 0,
      },
      bySource: subStats.bySource,
      registrationTrend: trend,
    };
  }
}

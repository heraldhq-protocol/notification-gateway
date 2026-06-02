import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { Redis } from 'ioredis';
import { decryptAes256Gcm } from '../../common/utils/crypto.util';
import { REDIS_CLIENT } from '../redis/redis.module';
import type {
  DecryptedChannels,
  ChannelDeliveryOutcome,
  ChannelDispatchResult,
  NotificationJobData,
} from '../../common/types/notification.types';
import { TelegramService } from './providers/telegram.provider';
import { SnsService } from './providers/sns.provider';
import { MailService } from '../mail/mail.service';
import { SesIdentityService } from '../mail/ses-identity.service';
import { TemplateService } from '../template/template.service';
import { PrismaService } from '../../database/prisma.service';

interface ProtocolAsset {
  assetType: string;
  url: string;
}

@Injectable()
export class ChannelDispatchService {
  private readonly logger = new Logger(ChannelDispatchService.name);
  private readonly isProduction: boolean;
  private readonly unsubscribeSecret: string;
  private readonly unsubscribeBaseUrl: string;
  private readonly trackingBaseUrl: string;

  constructor(
    private readonly mailService: MailService,
    private readonly telegramService: TelegramService,
    private readonly snsService: SnsService,
    private readonly templateService: TemplateService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sesIdentity: SesIdentityService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.isProduction =
      this.config.get<string>('NODE_ENV', 'development') === 'production';
    this.unsubscribeSecret = this.config.get<string>(
      'UNSUBSCRIBE_JWT_SECRET',
      'development-unsub-jwt-secret-32!!',
    );
    this.unsubscribeBaseUrl = this.config.get<string>(
      'UNSUBSCRIBE_BASE_URL',
      'https://notify.useherald.xyz',
    );
    this.trackingBaseUrl = this.config.get<string>(
      'GATEWAY_PUBLIC_URL',
      'https://api.useherald.xyz',
    );
  }

  /**
   * Dispatch a notification to all active channels.
   */
  async dispatch(
    channels: DecryptedChannels,
    job: NotificationJobData,
  ): Promise<ChannelDispatchResult> {
    const allowedChannels = this.resolveAllowedChannels(channels, job);

    const protocolAssets = await this.fetchProtocolAssets(job.protocolId);

    const promises: Array<Promise<ChannelDeliveryOutcome>> = [];

    if (allowedChannels.includes('email') && channels.email) {
      promises.push(this.deliverEmail(channels.email, job, protocolAssets));
    }

    if (allowedChannels.includes('telegram') && channels.telegramChatId) {
      promises.push(
        this.deliverTelegram(channels.telegramChatId, job, protocolAssets),
      );
    }

    if (allowedChannels.includes('sms') && channels.phone) {
      promises.push(this.deliverSms(channels.phone, job));
    }

    // No channels allowed (e.g. tier gate) — fail explicitly rather than
    // returning allDelivered=true from a vacuous 0===0 comparison.
    if (promises.length === 0) {
      return {
        outcomes: [],
        totalChannels: 0,
        successCount: 0,
        allDelivered: false,
      };
    }

    const settled = await Promise.allSettled(promises);
    const outcomes: ChannelDeliveryOutcome[] = settled.map((result) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        channel: 'unknown' as const,
        success: false,
        error: result.reason?.message ?? 'Unknown error',
      };
    });

    await this.persistChannelDeliveries(job.notificationId, outcomes);

    const successCount = outcomes.filter((o) => o.success).length;

    return {
      outcomes,
      totalChannels: outcomes.length,
      successCount,
      allDelivered: successCount === outcomes.length,
    };
  }

  /**
   * Fetch protocol assets (banner, video, logo) from database.
   */
  private async fetchProtocolAssets(
    protocolId: string,
  ): Promise<ProtocolAsset[]> {
    try {
      return await this.prisma.protocolAsset.findMany({
        where: {
          protocolId,
          isActive: true,
        },
        select: {
          assetType: true,
          url: true,
        },
      });
    } catch (err) {
      this.logger.warn('Failed to fetch protocol assets', {
        protocolId,
        error: (err as Error).message,
      });
      return [];
    }
  }

  /**
   * Resolve allowed channels based on configuration.
   */
  private resolveAllowedChannels(
    channels: DecryptedChannels,
    job: NotificationJobData,
  ): ('email' | 'telegram' | 'sms')[] {
    const tier = job.tier ?? 0;

    const registered: ('email' | 'telegram' | 'sms')[] = [];
    if (channels.email) registered.push('email');
    // Telegram and SMS both require Growth+ (tier >= 1)
    if (channels.telegramChatId && tier >= 1) registered.push('telegram');
    if (channels.phone && tier >= 1) registered.push('sms');

    if (registered.length === 0) return [];

    let explicit: ('email' | 'telegram' | 'sms')[] | undefined;
    if (job.preferredChannel) {
      explicit = [job.preferredChannel];
    } else if (job.channels && job.channels.length > 0) {
      explicit = job.channels;
    }

    const excluded = new Set(job.excludedChannels || []);

    let allowed: ('email' | 'telegram' | 'sms')[];

    if (explicit) {
      allowed = explicit.filter(
        (c) => registered.includes(c) && !excluded.has(c),
      );
    } else {
      allowed = registered.filter((c) => !excluded.has(c));
    }

    // Critical/important SMS escalation still respects the tier gate
    if (
      tier >= 1 &&
      (job.priority === 'important' || job.priority === 'critical') &&
      channels.phone &&
      !excluded.has('sms') &&
      !allowed.includes('sms')
    ) {
      allowed.push('sms');
    }

    const channelOrder: ('email' | 'telegram' | 'sms')[] = [
      'email',
      'telegram',
      'sms',
    ];
    allowed.sort((a, b) => channelOrder.indexOf(a) - channelOrder.indexOf(b));

    return allowed;
  }

  private async deliverEmail(
    email: string,
    job: NotificationJobData,
    assets: ProtocolAsset[],
  ): Promise<ChannelDeliveryOutcome> {
    const suppressed = job.walletHash
      ? await this.prisma.emailSuppression.findUnique({
          where: { walletHash: job.walletHash },
        })
      : null;
    if (suppressed) {
      this.logger.warn('Skipping email for suppressed wallet', {
        walletHash: suppressed.walletHash.slice(0, 8) + '...',
        reason: suppressed.reason,
      });
      return {
        channel: 'email',
        success: false,
        error: `Email suppressed: ${suppressed.reason}`,
      };
    }

    try {
      const customDomainRecord = await this.prisma.dkimKey.findFirst({
        where: {
          protocolId: job.protocolId,
          isActive: true,
          dnsVerified: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      const senderDomain = customDomainRecord
        ? customDomainRecord.domain
        : 'useherald.xyz';

      const formattedSubject = `[${job.protocolName}] ${job.subject}`;

      const bannerAsset = assets.find((a) => a.assetType === 'banner');
      const logoAsset = assets.find((a) => a.assetType === 'logo');

      const protocolSettings = await this.prisma.protocolSettings.findUnique({
        where: { protocolId: job.protocolId },
        select: { websiteUrl: true, trackEngagement: true },
      });

      const templateName = this.getTemplateName(job.category);
      const rendered = await this.templateService.render({
        template: templateName,
        templateId: job.templateId,
        tier: job.tier ?? 0,
        protocolId: job.protocolId,
        variables: {
          ...job.templateVariables,
          protocolName: job.protocolName,
          subject: job.subject,
          body: job.body,
          category: job.category,
          walletAddress: job.wallet,
          unsubscribeUrl: this.generateSignedUnsubscribeUrl(
            job.walletHash || '',
            job.category,
          ),
          logoUrl: logoAsset?.url ?? null,
          websiteUrl: protocolSettings?.websiteUrl ?? null,
          bannerUrl: bannerAsset?.url ?? null,
        },
      });
      let { html } = rendered;
      const { text } = rendered;

      // ── Engagement tracking injection ─────────────────────────────────────
      const trackingActive = !!protocolSettings?.trackEngagement;
      if (trackingActive && html) {
        const pid = encodeURIComponent(job.protocolId);
        const nid = encodeURIComponent(job.notificationId);
        const base = this.trackingBaseUrl;

        // Wrap href links (excluding unsubscribe URLs) with click-tracking
        html = html.replace(
          /href="(https?:\/\/(?!notify\.useherald\.xyz)[^"]+)"/g,
          (_match, url) => {
            const encoded = Buffer.from(url).toString('base64url');
            return `href="${base}/v1/track/click/${nid}?p=${pid}&url=${encoded}"`;
          },
        );

        // Inject 1×1 open-tracking pixel before </body>
        const pixel = `<img src="${base}/v1/track/open/${nid}?p=${pid}" width="1" height="1" style="display:none;border:0;" alt="" />`;
        html = html.includes('</body>')
          ? html.replace('</body>', `${pixel}</body>`)
          : html + pixel;

        // Stamp the notification record so analytics only count tracked sends
        await this.prisma.notification
          .update({
            where: { id: job.notificationId },
            data: { trackingEnabled: true },
          })
          .catch(() => {
            /* non-fatal — analytics might undercount, but email still sends */
          });
      }

      this.sesIdentity.ensureVerified(email).catch(() => {});

      const sendResult = await this.mailService.send({
        to: email,
        from: `${job.protocolName} via Herald <noreply@${senderDomain}>`,
        replyTo: 'support@useherald.xyz',
        subject: formattedSubject,
        html,
        text,
        headers: {
          'X-Herald-Protocol': job.protocolName,
          'X-Herald-Notification-Id': job.notificationId,
          'X-Herald-Timestamp': new Date().toISOString(),
          'List-Unsubscribe': `<${this.generateSignedUnsubscribeUrl(job.walletHash || '', job.category)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          Precedence: 'bulk',
          'X-Auto-Response-Suppress': 'OOF',
          'Auto-Submitted': 'auto-generated',
        },
      });

      this.logDelivery('email', job.notificationId, sendResult.messageId);

      return {
        channel: 'email',
        success: true,
        messageId: sendResult.messageId,
        provider: sendResult.provider,
      };
    } catch (err: any) {
      return {
        channel: 'email',
        success: false,
        error: err.message,
      };
    }
  }

  private async deliverTelegram(
    chatId: string,
    job: NotificationJobData,
    assets: ProtocolAsset[],
  ): Promise<ChannelDeliveryOutcome> {
    try {
      const bannerAsset = assets.find((a) => a.assetType === 'banner');
      const videoAsset = assets.find((a) => a.assetType === 'video');

      // Resolve custom bot token, group chat ID, thread ID, and engagement tracking for Growth+ protocols (tier >= 2)
      let customBotToken: string | undefined;
      let groupChatId: string | undefined;
      let messageThreadId: string | undefined;
      let trackEngagement = false;

      let autoPinEnabled = false;

      if (job.protocolId) {
        const settings = await this.prisma.protocolSettings.findUnique({
          where: { protocolId: job.protocolId },
          select: {
            telegramBotTokenEncrypted: true,
            telegramGroupChatId: true,
            telegramThreadIds: true,
            trackEngagement: true,
            telegramAutoPinEnabled: true,
          },
        });

        trackEngagement = !!settings?.trackEngagement;
        autoPinEnabled = !!settings?.telegramAutoPinEnabled;

        if ((job.tier ?? 0) >= 1) {
          if (settings?.telegramBotTokenEncrypted) {
            const encKey = this.config.get<string>('ENCRYPTION_KEY_ID');
            if (encKey) {
              customBotToken = decryptAes256Gcm(
                settings.telegramBotTokenEncrypted,
                encKey,
              );
            }
          }
          groupChatId = settings?.telegramGroupChatId ?? undefined;

          // Resolve topic thread ID for this notification's category
          if (settings?.telegramThreadIds && job.category) {
            const threadMap = settings.telegramThreadIds as Record<
              string,
              string
            >;
            messageThreadId = threadMap[job.category] ?? undefined;
          }
        }
      }

      // Check per-protocol mute (user tapped "Mute this protocol" button)
      const protocolMuteKey = `tg:mute:${chatId}:${job.protocolId}`;
      const protocolMuted = await this.redis
        .get(protocolMuteKey)
        .catch(() => null);
      if (protocolMuted) {
        return {
          channel: 'telegram',
          success: false,
          error: 'muted_by_user',
        };
      }

      // Check per-category mute (/mute <category> command)
      const categoryMuteKey = `tg:mute_cat:${chatId}:${job.category}`;
      const categoryMuted = await this.redis
        .get(categoryMuteKey)
        .catch(() => null);
      if (categoryMuted) {
        return {
          channel: 'telegram',
          success: false,
          error: `muted_category:${job.category}`,
        };
      }

      const baseParams = {
        protocolName: job.protocolName,
        protocolId: job.protocolId,
        subject: job.subject,
        body: job.body,
        category: job.category,
        notificationId: job.notificationId,
        tier: job.tier,
        templateId: job.telegramTemplateId,
        templateVariables: job.templateVariables,
        bannerUrl: bannerAsset?.url,
        videoUrl: videoAsset?.url,
        messageThreadId,
        priority: job.priority,
        trackEngagement,
        trackingBaseUrl: this.trackingBaseUrl,
      };

      // Individual subscriber delivery — always uses Herald's bot.
      // Subscribers opted in via Herald's bot so a custom bot cannot reach them.
      const result = await this.telegramService.sendNotification({
        chatId,
        ...baseParams,
      });
      this.logDelivery('telegram', job.notificationId, result.messageId);

      // Group/channel delivery — uses custom bot (which is admin of the group).
      // Deduplicated per notification so N subscribers don't send N group messages.
      if (groupChatId) {
        const groupSentKey = `tg:group_sent:${job.notificationId}:${groupChatId}`;
        const alreadySent = await this.redis
          .get(groupSentKey)
          .catch(() => null);

        if (!alreadySent) {
          const groupResult = await this.telegramService
            .sendNotification({
              chatId: groupChatId,
              ...baseParams,
              customBotToken,
            })
            .catch((err: Error) => {
              this.logger.warn(
                `Group Telegram delivery failed for protocol=${job.protocolId}: ${err.message}`,
              );
              return null;
            });

          if (groupResult) {
            await this.redis.setex(groupSentKey, 86400, '1');

            // Map the group message → notification so reaction events
            // (handled by the admin-api bot) can attribute engagement.
            await this.redis
              .setex(
                `tg:gmsg:${groupChatId}:${groupResult.messageId}`,
                7 * 86400,
                job.notificationId,
              )
              .catch(() => undefined);

            // Auto-pin for security/critical notifications when enabled
            const shouldPin =
              autoPinEnabled &&
              (job.category === 'security' ||
                job.priority === 'critical' ||
                job.priority === 'important');
            if (shouldPin) {
              await this.telegramService
                .pinGroupMessage(
                  groupChatId,
                  groupResult.messageId,
                  customBotToken,
                )
                .catch((err: Error) => {
                  this.logger.warn(
                    `Auto-pin failed for group=${groupChatId}: ${err.message}`,
                  );
                });
            }
          }
        }
      }

      return {
        channel: 'telegram',
        success: true,
        messageId: result.messageId,
        provider: 'telegram_bot_api',
      };
    } catch (err: any) {
      return {
        channel: 'telegram',
        success: false,
        error:
          err.message === 'BOT_BLOCKED' ? 'bot_blocked_by_user' : err.message,
      };
    }
  }

  private async deliverSms(
    phone: string,
    job: NotificationJobData,
  ): Promise<ChannelDeliveryOutcome> {
    try {
      const result = await this.snsService.sendSms({
        phone,
        protocolName: job.protocolName,
        subject: job.subject,
        body: job.body,
        category: job.category,
      });

      this.logDelivery('sms', job.notificationId, result.messageId);

      return {
        channel: 'sms',
        success: true,
        messageId: result.messageId,
        provider: 'aws_sns',
      };
    } catch (err: any) {
      return {
        channel: 'sms',
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Production-safe logging — never log decrypted channel identifiers.
   */
  private logDelivery(
    channel: string,
    notificationId: string,
    messageId: string | undefined,
  ): void {
    if (this.isProduction) {
      this.logger.log(`Delivered via ${channel}`, {
        notificationId,
        messageId,
      });
    } else {
      this.logger.log(`Delivered via ${channel}`, {
        notificationId,
        messageId,
        channel,
      });
    }
  }

  private async persistChannelDeliveries(
    notificationId: string,
    outcomes: ChannelDeliveryOutcome[],
  ): Promise<void> {
    try {
      await this.prisma.$transaction(
        outcomes.map((o) =>
          this.prisma.channelDelivery.create({
            data: {
              notificationId,
              channel: o.channel,
              success: o.success,
              messageId: o.messageId ?? null,
              provider: o.provider ?? null,
              error: o.error ?? null,
              deliveredAt: o.success ? new Date() : null,
            },
          }),
        ),
      );
    } catch (err) {
      this.logger.warn('Failed to persist channel deliveries', {
        notificationId,
        error: (err as Error).message,
      });
    }
  }

  private getTemplateName(category: string): string {
    const map: Record<string, string> = {
      defi: 'defi-alert',
      governance: 'governance',
      system: 'system',
      marketing: 'marketing',
    };
    return map[category] ?? 'defi-alert';
  }

  /**
   * Generate an HMAC-signed unsubscribe URL.
   * Supports per-category (e.g. 'governance') and full opt-out (category = null/'all').
   */
  private generateSignedUnsubscribeUrl(
    walletHash: string,
    category?: string | null,
  ): string {
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
    const payload = JSON.stringify({
      walletHash,
      category: category || null,
      expiresAt,
    });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const signature = createHmac('sha256', this.unsubscribeSecret)
      .update(payloadB64)
      .digest('base64url');
    return `${this.unsubscribeBaseUrl}/unsubscribe/${payloadB64}.${signature}`;
  }
}

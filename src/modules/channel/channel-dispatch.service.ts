import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  DecryptedChannels,
  ChannelDeliveryOutcome,
  ChannelDispatchResult,
  NotificationJobData,
} from '../../common/types/notification.types';
import { TelegramService } from './providers/telegram.provider';
import { SnsService } from './providers/sns.provider';
import { MailService } from '../mail/mail.service';
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

  constructor(
    private readonly mailService: MailService,
    private readonly telegramService: TelegramService,
    private readonly snsService: SnsService,
    private readonly templateService: TemplateService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.isProduction =
      this.config.get<string>('NODE_ENV', 'development') === 'production';
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
    const registered: ('email' | 'telegram' | 'sms')[] = [];
    if (channels.email) registered.push('email');
    if (channels.telegramChatId) registered.push('telegram');
    if (channels.phone) registered.push('sms');

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

    if (
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

      const catFriendly =
        job.category === 'defi'
          ? 'DeFi'
          : job.category.charAt(0).toUpperCase() + job.category.slice(1);
      const formattedSubject = `[${job.protocolName} | ${catFriendly} Alert] ${job.subject}`;

      const bannerAsset = assets.find((a) => a.assetType === 'banner');
      const logoAsset = assets.find((a) => a.assetType === 'logo');

      const templateName = this.getTemplateName(job.category);
      const { html, text } = await this.templateService.render({
        template: templateName,
        variables: {
          protocolName: job.protocolName,
          subject: formattedSubject,
          body: job.body,
          category: job.category,
          recipientAddress: job.wallet,
          unsubscribeUrl: `https://notify.useherald.xyz/unsubscribe/${job.notificationId}`,
          heraldLogoUrl:
            logoAsset?.url ?? 'https://cdn.useherald.xyz/logo-email.png',
          bannerUrl: bannerAsset?.url,
        },
      });

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
          'List-Unsubscribe': `<https://notify.useherald.xyz/unsubscribe/${job.notificationId}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'Precedence': 'bulk',
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

      const result = await this.telegramService.sendNotification({
        chatId,
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
      });

      this.logDelivery('telegram', job.notificationId, result.messageId);

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
        error: err.message,
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
}

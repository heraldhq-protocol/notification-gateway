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

/**
 * ChannelDispatchService — multi-channel delivery orchestrator.
 *
 * For each notification, dispatches to all active channels in parallel
 * using Promise.allSettled. A failure on one channel does NOT block others.
 *
 * SEC-001: Plaintext identifiers exist ONLY in local variables within dispatch().
 */
@Injectable()
export class ChannelDispatchService {
  private readonly logger = new Logger(ChannelDispatchService.name);

  constructor(
    private readonly mailService: MailService,
    private readonly telegramService: TelegramService,
    private readonly snsService: SnsService,
    private readonly templateService: TemplateService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Dispatch a notification to all active channels.
   *
   * @param channels - Decrypted channel identifiers (in-memory only)
   * @param job      - The notification job data
   * @returns Summary of delivery outcomes per channel
   */
  async dispatch(
    channels: DecryptedChannels,
    job: NotificationJobData,
  ): Promise<ChannelDispatchResult> {
    const promises: Array<Promise<ChannelDeliveryOutcome>> = [];

    // ── Email channel ─────────────────────────────────────────
    if (channels.email) {
      promises.push(this.deliverEmail(channels.email, job));
    }

    // ── Telegram channel ──────────────────────────────────────
    if (channels.telegramChatId) {
      promises.push(this.deliverTelegram(channels.telegramChatId, job));
    }

    // ── SMS channel ───────────────────────────────────────────
    if (channels.phone) {
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

    // Persist per-channel delivery records
    await this.persistChannelDeliveries(job.notificationId, outcomes);

    const successCount = outcomes.filter((o) => o.success).length;

    return {
      outcomes,
      totalChannels: outcomes.length,
      successCount,
      allDelivered: successCount === outcomes.length,
    };
  }

  // ── Email delivery ──────────────────────────────────────────

  private async deliverEmail(
    email: string,
    job: NotificationJobData,
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
          heraldLogoUrl: 'https://cdn.useherald.xyz/logo-email.png',
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
          Precedence: 'bulk',
        },
      });

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

  // ── Telegram delivery ───────────────────────────────────────

  private async deliverTelegram(
    chatId: string,
    job: NotificationJobData,
  ): Promise<ChannelDeliveryOutcome> {
    try {
      const result = await this.telegramService.sendNotification({
        chatId,
        protocolName: job.protocolName,
        subject: job.subject,
        body: job.body,
        category: job.category,
        notificationId: job.notificationId,
      });

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

  // ── SMS delivery ────────────────────────────────────────────

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

  // ── Helpers ─────────────────────────────────────────────────

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

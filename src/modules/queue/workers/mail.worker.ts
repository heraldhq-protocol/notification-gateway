import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueNames } from '../queue.constants';
import { RoutingService } from '../../routing/routing.service';
import { ChannelDispatchService } from '../../channel/channel-dispatch.service';
import { WebhookService } from '../../webhook/webhook.service';
import { OverageMeteringService } from '../../billing/overage-metering.service';
import { DigestService } from '../../notify/digest.service';
import { PrismaService } from '../../../database/prisma.service';
import type { NotificationJobData } from '../../../common/types/notification.types';

/**
 * MailWorker — processes notification delivery jobs via multi-channel dispatch.
 *
 * Flow (production):
 *   1. Check digestMode → buffer for later if true
 *   2. Resolve identity (cached PDA lookup, 10min TTL)
 *   3. Decrypt ALL active channels via TEE (single round-trip)
 *   4. Dispatch to all channels in parallel (email, telegram, sms)
 *   5. Update notification record with per-channel results
 *   6. Increment send counter for overage metering
 *   7. Fire webhook events (notification.delivered / notification.failed)
 *
 * Flow (sandbox):
 *   - Skips PDA lookup and TEE decryption entirely
 *   - Uses pre-resolved test contacts from job data
 *   - Delivers directly to protocol's configured test email/chat
 *
 * SEC-001: Plaintext identifiers exist ONLY in local variables within process().
 */
@Processor(QueueNames.NOTIFICATION, {
  lockDuration: 60000, // 60s headroom for multi-channel dispatch
  stalledInterval: 30000, // Check for stalled jobs every 30s
  maxStalledCount: 1, // Only allow one stall before moving to failed
})
@Injectable()
export class MailWorker extends WorkerHost {
  private readonly logger = new Logger(MailWorker.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly channelDispatch: ChannelDispatchService,
    private readonly webhookService: WebhookService,
    private readonly overageMetering: OverageMeteringService,
    private readonly digestService: DigestService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { notificationId, isSandbox } = job.data;

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'processing', processingAt: new Date() },
    });

    if (isSandbox) {
      return this.processSandbox(job);
    }
    return this.processProduction(job);
  }

  // ── Sandbox path ─────────────────────────────────────────────────────────

  private async processSandbox(job: Job<NotificationJobData>): Promise<void> {
    const {
      notificationId,
      testContact,
      protocolName,
      subject,
      body,
      category,
      tier,
    } = job.data;

    if (
      !testContact ||
      (!testContact.email && !testContact.telegramChatId && !testContact.phone)
    ) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: 'opted_out', errorCode: 'SANDBOX_NO_TEST_CONTACT' },
      });
      return;
    }

    try {
      // Dispatch directly to test contacts — no PDA/TEE needed
      const result = await this.channelDispatch.dispatch(
        {
          email: testContact.email,
          telegramChatId: testContact.telegramChatId,
          phone: testContact.phone,
        },
        {
          ...job.data,
          // tier already injected by notify service
        },
      );

      if (result.successCount > 0) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
      } else {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: 'failed', errorCode: 'SANDBOX_ALL_CHANNELS_FAILED' },
        });
      }

      this.logger.log('Sandbox notification dispatched', {
        notificationId,
        channels: result.totalChannels,
        delivered: result.successCount,
      });
    } catch (err: any) {
      this.logger.error('Sandbox notification delivery failed', {
        notificationId,
        error: err.message,
      });
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: 'failed', errorCode: 'SANDBOX_DELIVERY_ERROR' },
      });
    }
  }

  // ── Production path ───────────────────────────────────────────────────────

  private async processProduction(
    job: Job<NotificationJobData>,
  ): Promise<void> {
    const { notificationId, wallet, protocolId, digestMode } = job.data;

    try {
      // ── Step 0: Check digest mode ──────────────────────────────
      if (digestMode) {
        await this.digestService.bufferForDigest({
          walletHash: job.data.walletHash || '',
          protocolId: job.data.protocolId,
          subject: job.data.subject,
          body: job.data.body,
          category: job.data.category,
        });

        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: 'digested' },
        });

        this.logger.debug(`Notification ${notificationId} buffered for digest`);
        return;
      }

      // ── Step 1: Resolve identity ──────────────────────────────
      const identity = await this.routingService.resolveIdentity(wallet);
      if (!identity) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: 'opted_out',
            errorCode: 'WALLET_NOT_REGISTERED_AT_PROCESSING',
          },
        });
        return;
      }

      // ── Step 2: Decrypt ALL channels via TEE ──────────────────
      const channels =
        await this.routingService.decryptAllChannelsInEnclave(identity);

      const hasAnyChannel =
        channels.email || channels.telegramChatId || channels.phone;

      if (!hasAnyChannel) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: 'opted_out',
            errorCode: 'NO_ACTIVE_CHANNELS',
          },
        });
        return;
      }

      // ── Step 3: Dispatch to all channels ──────────────────────
      const result = await this.channelDispatch.dispatch(channels, job.data);

      // ── Step 4: Update notification record ─────────────────────
      let finalStatus: string;

      if (result.allDelivered) {
        finalStatus = 'delivered';
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
      } else if (result.successCount > 0) {
        finalStatus = 'partial';
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: 'partial',
            deliveredAt: new Date(),
            errorCode: `PARTIAL_${result.successCount}/${result.totalChannels}`,
          },
        });
      } else {
        finalStatus = 'failed';
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: 'failed',
            errorCode: 'ALL_CHANNELS_FAILED',
            retryCount: { increment: 1 },
          },
        });
        const errors = result.outcomes
          .filter((o) => !o.success)
          .map((o) => `${o.channel}: ${o.error}`)
          .join('; ');
        throw new Error(`All channels failed: ${errors}`);
      }

      // ── Step 5: Increment send counter (overage metering) ──────
      if (result.successCount > 0) {
        this.overageMetering
          .incrementSendsThisPeriod(protocolId, 1)
          .catch((err) =>
            this.logger.warn(
              `Metering increment failed for ${protocolId}: ${err.message}`,
            ),
          );
      }

      // ── Step 6: Fire webhook events ────────────────────────────
      const eventType =
        finalStatus === 'delivered'
          ? 'notification.delivered'
          : finalStatus === 'partial'
            ? 'notification.partial'
            : 'notification.failed';

      this.webhookService
        .dispatch(protocolId, eventType, {
          notificationId,
          wallet: job.data.wallet,
          status: finalStatus,
          channels: result.outcomes.map((o) => ({
            channel: o.channel,
            success: o.success,
            provider: o.provider,
          })),
          deliveredAt: new Date().toISOString(),
        })
        .catch((err) =>
          this.logger.warn(
            `Webhook dispatch failed for ${notificationId}: ${err.message}`,
          ),
        );

      this.logger.log('Notification dispatched', {
        notificationId,
        channels: result.totalChannels,
        delivered: result.successCount,
      });
    } catch (err: any) {
      if (err.message?.startsWith('All channels failed')) {
        throw err; // Re-throw for BullMQ retry
      }

      this.logger.error('Notification delivery failed', {
        notificationId,
        error: (err as Error).message,
      });
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: 'failed',
          errorCode: String(err.code || err.statusCode || 'DELIVERY_FAILED'),
          retryCount: { increment: 1 },
        },
      });

      // Fire failure webhook
      this.webhookService
        .dispatch(job.data.protocolId, 'notification.failed', {
          notificationId,
          wallet: job.data.wallet,
          status: 'failed',
          error: err.message,
        })
        .catch(() => {}); // Swallow — webhook failure shouldn't block error flow

      throw err;
    }
  }
}

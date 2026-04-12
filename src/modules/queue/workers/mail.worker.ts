import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueNames } from '../queue.constants';
import { RoutingService } from '../../routing/routing.service';
import { ChannelDispatchService } from '../../channel/channel-dispatch.service';
import { PrismaService } from '../../../database/prisma.service';
import type { NotificationJobData } from '../../../common/types/notification.types';

/**
 * MailWorker — processes notification delivery jobs via multi-channel dispatch.
 *
 * Flow (production):
 *   1. Resolve identity (cached PDA lookup, 10min TTL)
 *   2. Decrypt ALL active channels via TEE (single round-trip)
 *   3. Dispatch to all channels in parallel (email, telegram, sms)
 *   4. Update notification record with per-channel results
 *
 * Flow (sandbox):
 *   - Skips PDA lookup and TEE decryption entirely
 *   - Uses pre-resolved test contacts from job data
 *   - Delivers directly to protocol's configured test email/chat
 *
 * SEC-001: Plaintext identifiers exist ONLY in local variables within process().
 */
@Processor(QueueNames.NOTIFICATION, {
  stalledInterval: 30000, // Check for stalled jobs every 30s instead of 1s
  maxStalledCount: 1, // Only allow one stall before moving to failed
})
@Injectable()
export class MailWorker extends WorkerHost {
  private readonly logger = new Logger(MailWorker.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly channelDispatch: ChannelDispatchService,
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
    const { notificationId, wallet } = job.data;

    try {
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
      if (result.allDelivered) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
      } else if (result.successCount > 0) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: 'partial',
            deliveredAt: new Date(),
            errorCode: `PARTIAL_${result.successCount}/${result.totalChannels}`,
          },
        });
      } else {
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
      throw err;
    }
  }
}

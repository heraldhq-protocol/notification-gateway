import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { QueueNames } from '../queue/queue.constants';

/**
 * DigestService — buffers notifications for digest-mode users and flushes
 * them on a configurable schedule.
 *
 * Default flush interval: hourly.
 * Per-user override: via DigestQueue.scheduledFor timestamp.
 *
 * Flow:
 *   1. MailWorker detects digestMode=true → calls bufferForDigest()
 *   2. DigestService inserts into DigestQueue with scheduledFor = next flush time
 *   3. @Cron runs hourly → finds due entries → enqueues 'flush-digest' BullMQ jobs
 *   4. DigestWorker processes the job → sends consolidated email
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.DIGEST) private readonly digestQueue: Queue,
  ) {}

  /**
   * Buffer a notification for digest delivery instead of immediate send.
   *
   * @param walletHash - SHA-256 hash of the recipient wallet
   * @param protocolId - Protocol sending the notification
   * @param subject - Notification subject
   * @param body - Notification body (stored via arweave ID or inline)
   * @param category - Notification category
   * @param scheduledFor - Optional custom flush time (defaults to next hour)
   */
  async bufferForDigest(params: {
    walletHash: string;
    protocolId: string;
    subject: string;
    body: string;
    category: string;
    scheduledFor?: Date;
  }): Promise<void> {
    const nextFlush = params.scheduledFor || this.getNextHourlyFlush();

    await this.prisma.digestQueue.create({
      data: {
        walletHash: params.walletHash,
        protocolId: params.protocolId,
        subject: params.subject,
        category: params.category,
        scheduledFor: nextFlush,
        // bodyArweaveId can be populated later if body is stored on Arweave
      },
    });

    this.logger.debug(
      `Buffered digest for wallet ${params.walletHash.slice(0, 8)}... scheduled for ${nextFlush.toISOString()}`,
    );
  }

  /**
   * Hourly cron — find all digest entries that are due and enqueue
   * consolidated flush jobs grouped by wallet hash.
   */
  @Cron('0 0 * * * *') // Top of every hour
  async flushDueDigests(): Promise<void> {
    const now = new Date();

    // Find all unsent digest entries that are due
    const dueEntries = await this.prisma.digestQueue.findMany({
      where: {
        scheduledFor: { lte: now },
        sentAt: null,
      },
      orderBy: { queuedAt: 'asc' },
    });

    if (dueEntries.length === 0) {
      return;
    }

    this.logger.log(`Found ${dueEntries.length} due digest entries`);

    // Group by walletHash for consolidated delivery
    const grouped = new Map<
      string,
      Array<{
        id: string;
        protocolId: string;
        subject: string;
        category: string;
        queuedAt: Date;
      }>
    >();

    for (const entry of dueEntries) {
      const key = entry.walletHash;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push({
        id: entry.id,
        protocolId: entry.protocolId,
        subject: entry.subject,
        category: entry.category,
        queuedAt: entry.queuedAt,
      });
    }

    // Enqueue one BullMQ job per wallet
    for (const [walletHash, entries] of grouped) {
      await this.digestQueue.add(
        'flush-digest',
        {
          walletHash,
          entries,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId: `digest-${walletHash}-${Date.now()}`,
        },
      );
    }

    this.logger.log(
      `Enqueued ${grouped.size} digest flush jobs for ${dueEntries.length} entries`,
    );
  }

  /**
   * Mark digest entries as sent after successful delivery.
   */
  async markAsSent(entryIds: string[]): Promise<void> {
    await this.prisma.digestQueue.updateMany({
      where: { id: { in: entryIds } },
      data: { sentAt: new Date() },
    });
  }

  /**
   * Calculate the next hourly flush time.
   * Always rounds up to the next full hour.
   */
  private getNextHourlyFlush(): Date {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }
}

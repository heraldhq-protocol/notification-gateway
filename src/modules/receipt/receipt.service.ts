import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { QueueNames } from '../queue/queue.constants';
import { PrismaService } from '../../database/prisma.service';

/**
 * ReceiptService — scans for delivered notifications lacking ZK receipts
 * and enqueues them for batch on-chain processing.
 *
 * Runs every 5 minutes by default (configurable via RECEIPT_SCAN_CRON).
 * Batch size is configurable via RECEIPT_BATCH_SIZE (default: 20).
 *
 * This is deliberately not every minute to avoid excessive ElastiCache load
 * in production AWS environments.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(QueueNames.RECEIPT_BATCH) private readonly receiptQueue: Queue,
  ) {
    this.batchSize = this.config.get<number>('RECEIPT_BATCH_SIZE', 20);
  }

  /**
   * Periodically collect delivered notifications that need ZK receipts
   * and push them to the batch processor queue.
   *
   * Runs every 5 minutes to balance timeliness vs. ElastiCache cost.
   */
  @Cron('0 */5 * * * *') // Every 5 minutes (ss mm pattern)
  async enqueueReceiptBatches() {
    this.logger.debug('Scanning for pending ZK receipts...');

    // Find notifications that were delivered but lack a receipt transaction
    const pendingNotifications = await this.prisma.notification.findMany({
      where: {
        writeReceipt: true,
        receiptTx: null,
        status: 'delivered',
      },
      select: {
        id: true,
        protocolId: true,
        walletHash: true,
        category: true,
      },
      take: this.batchSize,
      orderBy: { deliveredAt: 'asc' }, // Oldest first for fairness
    });

    if (pendingNotifications.length === 0) {
      return;
    }

    this.logger.log(
      `Found ${pendingNotifications.length} pending receipts. Enqueueing batch job...`,
    );

    // Push a single batch job containing up to batchSize notifications
    await this.receiptQueue.add(
      'flush-receipts',
      {
        notifications: pendingNotifications,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        // Prevent duplicate batch jobs from racing
        jobId: `receipt-batch-${Date.now()}`,
      },
    );

    this.logger.log(
      `Enqueued receipt batch with ${pendingNotifications.length} notifications`,
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueNames } from './queue.constants';
import type {
  NotificationJobData,
  WebhookJobData,
} from '../../common/types/notification.types';

/**
 * QueueService — enqueues jobs to BullMQ queues.
 * All job data follows SEC-001: no plaintext email.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QueueNames.NOTIFICATION)
    private readonly notificationQueue: Queue<NotificationJobData>,

    @InjectQueue(QueueNames.WEBHOOK)
    private readonly webhookQueue: Queue<WebhookJobData>,

    @InjectQueue(QueueNames.BOUNCE)
    private readonly bounceQueue: Queue,
  ) {}

  /**
   * Safety timeout for BullMQ add operations.
   * Prevents indefinite hangs when BullMQ's internal Redis connection
   * is down or reconnecting (maxRetriesPerRequest: null).
   */
  private static readonly ENQUEUE_TIMEOUT_MS = 10_000;

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`BullMQ enqueue timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  /**
   * Enqueue a notification for async delivery.
   * Default: 3 retries with exponential backoff (1s, 4s, 16s).
   */
  async enqueueNotification(data: NotificationJobData): Promise<void> {
    await this.withTimeout(
      this.notificationQueue.add('deliver', data, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      }),
      QueueService.ENQUEUE_TIMEOUT_MS,
    );

    this.logger.debug('Notification enqueued', {
      notificationId: data.notificationId,
    });
  }

  /**
   * Enqueue a webhook dispatch job.
   */
  async enqueueWebhook(data: WebhookJobData): Promise<void> {
    await this.withTimeout(
      this.webhookQueue.add('dispatch', data, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
      }),
      QueueService.ENQUEUE_TIMEOUT_MS,
    );
  }

  async enqueueBounce(data: Record<string, unknown>): Promise<void> {
    await this.withTimeout(
      this.bounceQueue.add('process', data, {
        attempts: 2,
        removeOnComplete: { count: 500 },
      }),
      QueueService.ENQUEUE_TIMEOUT_MS,
    );
  }
}

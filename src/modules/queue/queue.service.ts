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
  ) { }

  /**
   * Enqueue a notification for async delivery.
   * Default: 3 retries with exponential backoff (1s, 4s, 16s).
   */
  async enqueueNotification(data: NotificationJobData): Promise<void> {
    await this.notificationQueue.add('deliver', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });

    this.logger.debug('Notification enqueued', {
      notificationId: data.notificationId,
    });
  }

  /**
   * Enqueue a webhook dispatch job.
   */
  async enqueueWebhook(data: WebhookJobData): Promise<void> {
    await this.webhookQueue.add('dispatch', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    });
  }

  /**
   * Enqueue a bounce processing job.
   */
  async enqueueBounce(data: Record<string, unknown>): Promise<void> {
    await this.bounceQueue.add('process', data, {
      attempts: 2,
      removeOnComplete: { count: 500 },
    });
  }
}

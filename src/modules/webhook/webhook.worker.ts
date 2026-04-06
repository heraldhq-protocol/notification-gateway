import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac } from 'crypto';
import { QueueNames } from '../queue/queue.constants';
import { PrismaService } from '../../database/prisma.service';
import { WebhookPayload } from './webhook.service';

interface WebhookJobData {
  webhookId: string;
  url: string;
  secret: string;
  payload: WebhookPayload;
}

@Processor(QueueNames.WEBHOOK)
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookJobData, any, string>): Promise<void> {
    const { webhookId, url, secret, payload } = job.data;
    const bodyString = JSON.stringify(payload);

    // Generate HMAC SHA-256 signature
    const signature = createHmac('sha256', secret)
      .update(bodyString)
      .digest('hex');

    const headers = {
      'Content-Type': 'application/json',
      'X-Herald-Signature': signature,
      'X-Herald-Event': payload.eventType,
      'X-Herald-Delivery': payload.eventId,
    };

    const startTime = Date.now();
    let success = false;
    let httpStatus: number | null = null;
    let errorMsg: string | null = null;

    try {
      this.logger.debug(`Sending webhook ${payload.eventId} to ${url}`);
      const response = await axios.post(url, bodyString, {
        headers,
        timeout: 10000,
      });
      httpStatus = response.status;
      success = response.status >= 200 && response.status < 300;
      if (!success) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error: any) {
      httpStatus = error.response?.status || null;
      errorMsg = error.message;
      this.logger.warn(
        `Webhook ${payload.eventId} to ${url} failed: ${errorMsg}`,
      );
      throw error; // Let BullMQ handle retries
    } finally {
      const latencyMs = Date.now() - startTime;

      // Record delivery attempt
      await this.prisma.webhookDelivery.create({
        data: {
          webhookId,
          event: payload.eventType,
          httpStatus,
          latencyMs,
          attempt: job.attemptsMade + 1,
          success,
          error: errorMsg,
          notificationId: payload.data?.notificationId, // Optional linking if event relates to notification
        },
      });

      // Update webhook statistics
      if (success) {
        await this.prisma.webhook.update({
          where: { id: webhookId },
          data: {
            failureCount: 0,
            lastSuccessAt: new Date(),
          },
        });
      } else {
        await this.prisma.webhook.update({
          where: { id: webhookId },
          data: {
            failureCount: { increment: 1 },
            lastFailureAt: new Date(),
          },
        });
      }
    }
  }
}

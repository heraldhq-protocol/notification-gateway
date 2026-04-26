import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

/**
 * WebhookWorker — delivers webhook events via HTTP POST with HMAC signing.
 *
 * Features:
 *   - HMAC SHA-256 signature in X-Herald-Signature header
 *   - Automatic retry with exponential backoff (handled by BullMQ)
 *   - Delivery tracking in webhook_deliveries table
 *   - Auto-disable after N consecutive failures (prevents infinite retries)
 *   - Timestamp header for replay protection
 */
@Processor(QueueNames.WEBHOOK, {
  lockDuration: 60000,
  stalledInterval: 30000,
  maxStalledCount: 1,
})
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);
  private readonly autoDisableThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
    this.autoDisableThreshold = this.config.get<number>(
      'WEBHOOK_AUTO_DISABLE_THRESHOLD',
      10,
    );
  }

  async process(job: Job<WebhookJobData, any, string>): Promise<void> {
    const { webhookId, url, secret, payload } = job.data;

    // ── Pre-flight: check if webhook is still active and not over failure threshold ──
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { isActive: true, failureCount: true },
    });

    if (!webhook || !webhook.isActive) {
      this.logger.debug(
        `Webhook ${webhookId} is inactive or deleted, skipping delivery`,
      );
      return; // Don't retry — webhook is gone or disabled
    }

    if (webhook.failureCount >= this.autoDisableThreshold) {
      // Auto-disable: too many consecutive failures
      await this.prisma.webhook.update({
        where: { id: webhookId },
        data: { isActive: false },
      });
      this.logger.warn(
        `Auto-disabled webhook ${webhookId} after ${webhook.failureCount} consecutive failures. URL: ${url}`,
      );
      return; // Don't retry
    }

    const bodyString = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // ── SSRF Protection ──
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      this.logger.warn(`Invalid webhook URL: ${url}`);
      return;
    }

    const allowLocal = this.config.get<boolean>('ALLOW_LOCAL_WEBHOOKS');
    if (!allowLocal) {
      try {
        const dns = await import('dns/promises');
        const ipaddr = await import('ipaddr.js');
        const lookup = await dns.lookup(parsedUrl.hostname);
        const ip = ipaddr.parse(lookup.address);

        let range = ip.range();
        if (range === 'ipv4Mapped') {
          const v4 = (ip as import('ipaddr.js').IPv6).toIPv4Address();
          range = v4.range();
        }

        if (range !== 'unicast') {
          throw new Error(
            `SSRF Blocked: IP resolved to non-unicast range (${range})`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `SSRF validation failed for URL ${url}: ${(err as Error).message}`,
        );
        throw new Error('SSRF_BLOCKED');
      }
    }

    // Generate HMAC SHA-256 signature over timestamp + body for replay protection
    const signaturePayload = `${timestamp}.${bodyString}`;
    const signature = createHmac('sha256', secret)
      .update(signaturePayload)
      .digest('hex');

    const headers = {
      'Content-Type': 'application/json',
      'X-Herald-Signature': signature,
      'X-Herald-Timestamp': timestamp,
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
            failureCount: 0, // Reset on success
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

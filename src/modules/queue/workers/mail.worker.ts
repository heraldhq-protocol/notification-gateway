import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueNames } from '../queue.constants.js';
import { RoutingService } from '../../routing/routing.service.js';
import { MailService } from '../../mail/mail.service.js';
import { TemplateService } from '../../template/template.service.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type { NotificationJobData } from '../../../common/types/notification.types.js';
import { createHash } from 'crypto';

/**
 * MailWorker — processes notification delivery jobs.
 *
 * Flow:
 *   1. Resolve identity (cached PDA lookup)
 *   2. Decrypt email via TEE (in-memory only)
 *   3. Render email template (MJML → HTML)
 *   4. Send email through configured provider
 *   5. Update notification record
 *   6. Dispatch webhook events
 *
 * SEC-001: Email plaintext exists ONLY in local variables within process().
 */
@Processor(QueueNames.NOTIFICATION)
@Injectable()
export class MailWorker extends WorkerHost {
  private readonly logger = new Logger(MailWorker.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly mailService: MailService,
    private readonly templateService: TemplateService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const {
      notificationId,
      wallet,
      subject,
      body,
      category,
      protocolName,
      writeReceipt,
    } = job.data;

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'processing', processingAt: new Date() },
    });

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

      // ── Step 2: Decrypt email via TEE ─────────────────────────
      const email = await this.routingService.decryptEmailInEnclave(identity);

      // ── Step 3: Render email template ─────────────────────────
      const templateName = this.getTemplateName(category);
      const { html, text } = await this.templateService.render({
        template: templateName,
        variables: {
          protocolName,
          subject,
          body,
          category,
          unsubscribeUrl: `https://notify.herald.xyz/unsubscribe/${notificationId}`,
          heraldLogoUrl: 'https://cdn.herald.xyz/logo-email.png',
        },
      });

      // ── Step 4: Send email ────────────────────────────────────
      const sendResult = await this.mailService.send({
        to: email, // In-memory only — never logged
        from: `${protocolName} via Herald <noreply@herald.xyz>`,
        replyTo: 'support@herald.xyz',
        subject,
        html,
        text,
        headers: {
          'X-Herald-Notification-Id': notificationId,
          'X-Herald-Category': category,
        },
      });

      // ── Step 5: Update notification record ────────────────────
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: 'delivered',
          sesMessageId: sendResult.messageId,
          emailProvider: sendResult.provider,
          deliveredAt: new Date(),
        },
      });

      this.logger.log('Notification delivered', {
        notificationId,
        provider: sendResult.provider,
      });

      // EMAIL VARIABLE IS NOW OUT OF SCOPE — GC will collect
    } catch (err) {
      this.logger.error('Notification delivery failed', {
        notificationId,
        error: (err as Error).message,
      });
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: 'failed',
          errorCode: (err as Record<string, string>).code ?? 'DELIVERY_FAILED',
          retryCount: { increment: 1 },
        },
      });
      throw err; // BullMQ retries
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

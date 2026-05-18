import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { QueueNames } from '../queue/queue.constants';
import type { NotificationJobData } from '../../common/types/notification.types';

export interface ScheduleOnceDto {
  wallet?: string;
  subject: string;
  body: string;
  category?: string;
  channels?: string[];
  scheduledFor: string;
  timezone?: string;
  templateId?: string;
}

export interface ScheduleRecurringDto {
  wallet?: string;
  subject: string;
  body: string;
  category?: string;
  channels?: string[];
  cronExpr: string;
  timezone?: string;
  templateId?: string;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.NOTIFICATION)
    private readonly notificationQueue: Queue<NotificationJobData>,
  ) {}

  /** Schedule a one-time notification for a future date. */
  async scheduleOnce(protocolId: string, dto: ScheduleOnceDto) {
    return this.prisma.scheduledNotification.create({
      data: {
        protocolId,
        wallet: dto.wallet ?? null,
        subject: dto.subject,
        body: dto.body,
        category: dto.category ?? 'defi',
        channels: dto.channels ?? ['email'],
        scheduleType: 'ONE_TIME',
        timezone: dto.timezone ?? 'UTC',
        nextRunAt: new Date(dto.scheduledFor),
        status: 'PENDING',
        templateId: dto.templateId ?? null,
      },
    });
  }

  /** Schedule a recurring notification via cron expression. */
  async scheduleRecurring(protocolId: string, dto: ScheduleRecurringDto) {
    const nextRunAt = this.getNextCronRun(dto.cronExpr);
    return this.prisma.scheduledNotification.create({
      data: {
        protocolId,
        wallet: dto.wallet ?? null,
        subject: dto.subject,
        body: dto.body,
        category: dto.category ?? 'defi',
        channels: dto.channels ?? ['email'],
        scheduleType: 'RECURRING',
        cronExpr: dto.cronExpr,
        timezone: dto.timezone ?? 'UTC',
        nextRunAt,
        status: 'PENDING',
        templateId: dto.templateId ?? null,
      },
    });
  }

  /** List scheduled notifications for a protocol (excluding cancelled). */
  async listScheduled(protocolId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.scheduledNotification.findMany({
        where: { protocolId, status: { not: 'CANCELLED' } },
        orderBy: { nextRunAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.scheduledNotification.count({
        where: { protocolId, status: { not: 'CANCELLED' } },
      }),
    ]);
    return { items, total, page, limit };
  }

  /** Cancel a pending scheduled notification. */
  async cancelScheduled(protocolId: string, id: string) {
    await this.prisma.scheduledNotification.updateMany({
      where: { id, protocolId, status: { in: ['PENDING'] } },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * Reconcile overdue PENDING jobs every 5 minutes.
   * Picks up to 200 overdue jobs, creates Notification rows, and enqueues BullMQ jobs.
   */
  @Cron('*/5 * * * *')
  async reconcilePendingJobs() {
    const now = new Date();
    const overdue = await this.prisma.scheduledNotification.findMany({
      where: { status: 'PENDING', nextRunAt: { lte: now } },
      take: 200,
    });

    if (overdue.length === 0) return;

    this.logger.log(
      `Reconciling ${overdue.length} overdue scheduled notification(s)`,
    );

    for (const job of overdue) {
      try {
        // Mark as RUNNING first to prevent duplicate processing
        await this.prisma.scheduledNotification.update({
          where: { id: job.id },
          data: { status: 'RUNNING', lastRunAt: now },
        });

        if (job.wallet) {
          const notificationId = uuidv4();
          const walletHash = createHash('sha256')
            .update(job.wallet)
            .digest('hex');
          const subjectHash = createHash('sha256')
            .update(job.subject)
            .digest('hex');

          await this.prisma.notification.create({
            data: {
              id: notificationId,
              walletHash,
              subjectHash,
              protocolId: job.protocolId,
              status: 'queued',
              category: job.category,
              writeReceipt: false,
              queuedAt: now,
            },
          });

          await this.notificationQueue.add(
            'deliver',
            {
              notificationId,
              protocolId: job.protocolId,
              protocolPubkey: '',
              protocolName: '',
              wallet: job.wallet,
              walletHash,
              subject: job.subject,
              body: job.body,
              category: job.category,
              writeReceipt: false,
              digestMode: false,
              isSandbox: false,
              templateId: job.templateId ?? undefined,
            } satisfies NotificationJobData,
            {
              jobId: `scheduled-${job.id}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1000 },
            },
          );
        }

        // Handle recurring: compute next run and reset to PENDING
        if (job.scheduleType === 'RECURRING' && job.cronExpr) {
          const nextRunAt = this.getNextCronRun(job.cronExpr);
          await this.prisma.scheduledNotification.update({
            where: { id: job.id },
            data: { status: 'PENDING', nextRunAt },
          });
        } else {
          await this.prisma.scheduledNotification.update({
            where: { id: job.id },
            data: { status: 'COMPLETED' },
          });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `Failed to process scheduled job ${job.id}: ${message}`,
        );
        await this.prisma.scheduledNotification
          .update({ where: { id: job.id }, data: { status: 'FAILED' } })
          .catch(() => {});
      }
    }
  }

  /**
   * Compute the next fire time for a 5-field cron expression.
   * Handles simple patterns; falls back to +1 hour for unrecognised expressions.
   */
  private getNextCronRun(cronExpr: string): Date {
    try {
      const parts = cronExpr.trim().split(/\s+/);
      if (parts.length !== 5) return new Date(Date.now() + 3_600_000);

      const [minute, hour] = parts;

      if (minute.startsWith('*/')) {
        const interval = parseInt(minute.slice(2), 10) * 60_000;
        return new Date(Date.now() + interval);
      }
      if (hour.startsWith('*/')) {
        const interval = parseInt(hour.slice(2), 10) * 3_600_000;
        return new Date(Date.now() + interval);
      }

      // Default: next day same time
      return new Date(Date.now() + 86_400_000);
    } catch {
      return new Date(Date.now() + 3_600_000);
    }
  }
}

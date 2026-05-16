import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class BounceService {
  private readonly logger = new Logger(BounceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async processResendEvent(eventType: string, data: Record<string, unknown>) {
    const emailId = (data.email_id ?? data.id) as string | undefined;

    if (!emailId) {
      this.logger.warn('Resend event missing email ID');
      return;
    }

    const notification = await this.prisma.notification.findFirst({
      where: { sesMessageId: emailId },
    });

    if (!notification) {
      this.logger.warn('Resend event for unknown notification', { emailId });
      return;
    }

    if (eventType === 'email.bounced') {
      this.logger.warn('Resend bounce — identity suspension', {
        emailId: emailId.slice(0, 12) + '...',
      });

      await this.prisma.emailBounce.create({
        data: {
          notificationId: notification.id,
          walletHash: notification.walletHash,
          bounceType: 'hard',
          sesMessageId: emailId,
        },
      });

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { bounce: true, bounceType: 'hard' },
      });

      await this.prisma.emailSuppression.upsert({
        where: { walletHash: notification.walletHash },
        update: { reason: 'hard_bounce', suppressedAt: new Date() },
        create: {
          walletHash: notification.walletHash,
          reason: 'hard_bounce',
          notificationId: notification.id,
        },
      });
    } else if (eventType === 'email.complained') {
      await this.prisma.emailBounce.create({
        data: {
          notificationId: notification.id,
          walletHash: notification.walletHash,
          bounceType: 'complaint',
          sesMessageId: emailId,
        },
      });

      await this.prisma.emailSuppression.upsert({
        where: { walletHash: notification.walletHash },
        update: { reason: 'complaint', suppressedAt: new Date() },
        create: {
          walletHash: notification.walletHash,
          reason: 'complaint',
          notificationId: notification.id,
        },
      });
    } else if (eventType === 'email.delivered') {
      await this.prisma.emailDelivery.create({
        data: {
          notificationId: notification.id,
          sesMessageId: emailId,
        },
      });

      this.logger.log('Resend delivery confirmed', {
        emailId: emailId.slice(0, 12) + '...',
        notificationId: notification.id,
      });
    }
  }

  async processSesBounce(message: any) {
    const sesNotificationType = message.notificationType as string;
    const mail = message.mail as Record<string, unknown>;
    const sesMessageId = mail?.messageId as string;

    if (!sesMessageId) {
      this.logger.warn('SES notification missing messageId');
      return;
    }

    const notification = await this.prisma.notification.findFirst({
      where: { sesMessageId },
    });

    if (!notification) {
      this.logger.warn('Bounce for unknown notification', { sesMessageId });
      return;
    }

    if (sesNotificationType === 'Bounce') {
      const bounce = message.bounce as Record<string, unknown>;
      const bounceType = bounce?.bounceType === 'Permanent' ? 'hard' : 'soft';

      await this.prisma.emailBounce.create({
        data: {
          notificationId: notification.id,
          walletHash: notification.walletHash,
          bounceType,
          sesMessageId,
          diagnosticCode: (
            bounce?.bouncedRecipients as Record<string, string>[]
          )?.[0]?.diagnosticCode,
        },
      });

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { bounce: true, bounceType },
      });

      if (bounceType === 'soft') {
        const latestHardBounce = await this.prisma.emailBounce.findFirst({
          where: {
            walletHash: notification.walletHash,
            bounceType: { in: ['hard', 'complaint'] },
          },
          orderBy: { bouncedAt: 'desc' },
        });

        const latestDelivery = await this.prisma.emailDelivery.findFirst({
          where: { notification: { walletHash: notification.walletHash } },
          orderBy: { deliveredAt: 'desc' },
        });

        const resetTimes = [
          latestHardBounce?.bouncedAt,
          latestDelivery?.deliveredAt,
        ].filter((d): d is Date => d !== undefined);

        const cutoff =
          resetTimes.length > 0
            ? resetTimes.reduce((max, d) => (d > max ? d : max))
            : new Date(0);

        const consecutiveSofts = await this.prisma.emailBounce.count({
          where: {
            walletHash: notification.walletHash,
            bounceType: 'soft',
            bouncedAt: { gt: cutoff },
          },
        });

        if (consecutiveSofts >= 3) {
          this.logger.warn(
            '3+ soft bounces — identity suspension recommended',
            { walletHash: notification.walletHash.slice(0, 8) + '...' },
          );
          await this.prisma.emailSuppression.upsert({
            where: { walletHash: notification.walletHash },
            update: { reason: 'soft_bounce', suppressedAt: new Date() },
            create: {
              walletHash: notification.walletHash,
              reason: 'soft_bounce',
              notificationId: notification.id,
            },
          });
        }
      } else {
        this.logger.warn('Hard bounce — identity suspension recommended', {
          walletHash: notification.walletHash.slice(0, 8) + '...',
        });
        await this.prisma.emailSuppression.upsert({
          where: { walletHash: notification.walletHash },
          update: { reason: 'hard_bounce', suppressedAt: new Date() },
          create: {
            walletHash: notification.walletHash,
            reason: 'hard_bounce',
            notificationId: notification.id,
          },
        });
      }
    } else if (sesNotificationType === 'Complaint') {
      await this.prisma.emailBounce.create({
        data: {
          notificationId: notification.id,
          walletHash: notification.walletHash,
          bounceType: 'complaint',
          sesMessageId,
        },
      });

      await this.prisma.emailSuppression.upsert({
        where: { walletHash: notification.walletHash },
        update: { reason: 'complaint', suppressedAt: new Date() },
        create: {
          walletHash: notification.walletHash,
          reason: 'complaint',
          notificationId: notification.id,
        },
      });
    } else if (sesNotificationType === 'Delivery') {
      const delivery = message.delivery as Record<string, unknown> | undefined;
      await this.prisma.emailDelivery.create({
        data: {
          notificationId: notification.id,
          sesMessageId,
          smtpResponse: (delivery?.smtpResponse as string) ?? null,
          processingTime: (delivery?.processingTimeMillis as number) ?? null,
        },
      });
      this.logger.log('Email delivery confirmed', {
        sesMessageId,
        notificationId: notification.id,
      });
    }
  }
}

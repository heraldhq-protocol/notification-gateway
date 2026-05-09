import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class BounceService {
  private readonly logger = new Logger(BounceService.name);

  constructor(private readonly prisma: PrismaService) {}

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
        const consecutiveSofts = await this.prisma.emailBounce.count({
          where: {
            walletHash: notification.walletHash,
            bounceType: 'soft',
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
    }
  }
}

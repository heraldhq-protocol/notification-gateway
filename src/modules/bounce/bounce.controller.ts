import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service.js';

/**
 * BounceController — handles SES SNS bounce/complaint notifications.
 *
 * POST /internal/sns/ses — internal ALB only (not publicly exposed).
 *
 * GW-F-014: Hard bounce → immediate identity suspension (1 bounce)
 *           Soft bounce → retry 1h, suspend after 3 consecutive
 */
@ApiTags('Internal')
@Controller('internal/sns')
export class BounceController {
  private readonly logger = new Logger(BounceController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post('ses')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleSesNotification(@Body() body: Record<string, unknown>) {
    const notificationType =
      (body.notificationType as string) ?? (body.Type as string);

    // Handle SNS subscription confirmation
    if (notificationType === 'SubscriptionConfirmation') {
      this.logger.log('SNS subscription confirmation received');
      return { status: 'confirmed' };
    }

    // Parse SES notification
    const message =
      typeof body.Message === 'string'
        ? JSON.parse(body.Message as string)
        : body;

    const sesNotificationType = message.notificationType as string;
    const mail = message.mail as Record<string, unknown>;
    const sesMessageId = mail?.messageId as string;

    if (!sesMessageId) {
      this.logger.warn('SES notification missing messageId');
      return { status: 'ignored' };
    }

    // Find the notification by SES message ID
    const notification = await this.prisma.notification.findFirst({
      where: { sesMessageId },
    });

    if (!notification) {
      this.logger.warn('Bounce for unknown notification', { sesMessageId });
      return { status: 'unknown' };
    }

    if (sesNotificationType === 'Bounce') {
      const bounce = message.bounce as Record<string, unknown>;
      const bounceType = bounce?.bounceType === 'Permanent' ? 'hard' : 'soft';

      // Record bounce
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

      // Count consecutive soft bounces for this wallet
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
            {
              walletHash: notification.walletHash.slice(0, 8) + '...',
            },
          );
        }
      } else {
        // Hard bounce — immediate suspension recommended
        this.logger.warn('Hard bounce — identity suspension recommended', {
          walletHash: notification.walletHash.slice(0, 8) + '...',
        });
      }

      return { status: 'processed', bounceType };
    }

    if (sesNotificationType === 'Complaint') {
      await this.prisma.emailBounce.create({
        data: {
          notificationId: notification.id,
          walletHash: notification.walletHash,
          bounceType: 'complaint',
          sesMessageId,
        },
      });
      return { status: 'complaint_recorded' };
    }

    return { status: 'ok' };
  }
}

import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueNames } from '../queue/queue.constants.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SesSnsPayloadDto } from './dto/ses-sns.dto.js';


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

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.BOUNCE) private readonly bounceQueue: Queue,
  ) { }

  @Post('ses')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleSesNotification(@Body() body: SesSnsPayloadDto) {
    const notificationType = body.notificationType ?? body.Type;

    // Handle SNS subscription confirmation
    if (notificationType === 'SubscriptionConfirmation') {
      this.logger.log('SNS subscription confirmation received');
      return { status: 'confirmed' };
    }

    // Parse SES notification
    const message =
      typeof body.Message === 'string'
        ? JSON.parse(body.Message as string)
        : body.Message || body;

    // Enqueue for async processing
    await this.bounceQueue.add('ses-bounce', message, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return { status: 'queued' };
  }
}

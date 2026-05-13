import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { BounceService } from './bounce.service';

/**
 * ResendWebhookController — handles Resend event webhooks.
 *
 * POST /internal/webhooks/resend — internal ALB only (not publicly exposed).
 *
 * Events handled:
 *   email.bounced   → identity suspension (hard bounce)
 *   email.complained → immediate suppression
 *   email.delivered  → EmailDelivery record
 */
@ApiTags('Internal')
@Controller('internal/webhooks')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(private readonly bounceService: BounceService) {}

  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleResendEvent(@Body() body: Record<string, unknown>) {
    const eventType = body.type as string | undefined;
    const eventData = body.data as Record<string, unknown> | undefined;

    if (!eventType || !eventData) {
      this.logger.warn('Resend webhook missing type or data');
      return { status: 'ignored' };
    }

    await this.bounceService.processResendEvent(eventType, eventData);

    return { status: 'processed' };
  }
}

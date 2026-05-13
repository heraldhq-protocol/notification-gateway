import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Webhook } from 'svix';
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

  constructor(
    private readonly bounceService: BounceService,
    private readonly configService: ConfigService,
  ) {}

  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleResendEvent(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const secret = this.configService.get<string>('RESEND_WEBHOOK_SECRET');
    if (secret) {
      try {
        const wh = new Webhook(secret);
        wh.verify(JSON.stringify(body), {
          'svix-id': req.headers['svix-id'] as string,
          'svix-timestamp': req.headers['svix-timestamp'] as string,
          'svix-signature': req.headers['svix-signature'] as string,
        });
      } catch {
        this.logger.warn('Resend webhook signature verification failed');
        throw new UnauthorizedException('Invalid webhook signature');
      }
    }

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

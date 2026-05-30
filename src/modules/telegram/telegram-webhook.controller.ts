import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { TelegramWebhookService } from './telegram-webhook.service';

@Controller('v1/tg')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(private readonly webhookService: TelegramWebhookService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() update: Record<string, any>): Promise<void> {
    try {
      await this.webhookService.handleUpdate(update);
    } catch (err) {
      this.logger.error('Telegram webhook processing failed', {
        error: (err as Error).message,
      });
    }
  }

  @Get('c/:notifId')
  async trackClick(
    @Param('notifId') notifId: string,
    @Query('url') urlB64: string,
    @Res() res: Response,
  ): Promise<void> {
    let destination = 'https://useherald.xyz';
    if (urlB64) {
      try {
        destination = Buffer.from(urlB64, 'base64url').toString('utf8');
        // Validate it's an http/https URL before redirecting
        const parsed = new URL(destination);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          destination = 'https://useherald.xyz';
        }
      } catch {
        destination = 'https://useherald.xyz';
      }
    }

    this.webhookService.recordClickAsync(notifId).catch(() => undefined);
    res.redirect(302, destination);
  }
}

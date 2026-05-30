import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
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
}

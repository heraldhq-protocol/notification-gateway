import { Module } from '@nestjs/common';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramWebhookService } from './telegram-webhook.service';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramWebhookService],
  exports: [TelegramWebhookService],
})
export class TelegramModule {}

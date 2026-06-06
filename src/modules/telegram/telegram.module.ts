import { Module } from '@nestjs/common';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramWebhookService } from './telegram-webhook.service';
import { PrismaModule } from '../../database/prisma.module';
import { ChannelModule } from '../channel/channel.module';
import { AuthModule } from '../auth/auth.module';

// TelegramMigrationService is provided by ChannelModule (which this module
// imports) to avoid a circular dependency.
@Module({
  imports: [PrismaModule, ChannelModule, AuthModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramWebhookService],
  exports: [TelegramWebhookService],
})
export class TelegramModule {}

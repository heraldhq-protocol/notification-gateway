import { Module } from '@nestjs/common';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramWebhookService } from './telegram-webhook.service';
import { PrismaModule } from '../../database/prisma.module';
import { ChannelModule } from '../channel/channel.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule provides AuthService for the AuthGuard/ScopeGuard used on the
  // /tg/preview endpoint in TelegramWebhookController.
  imports: [PrismaModule, ChannelModule, AuthModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramWebhookService],
  exports: [TelegramWebhookService],
})
export class TelegramModule {}

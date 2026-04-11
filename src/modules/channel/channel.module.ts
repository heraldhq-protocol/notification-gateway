import { Module } from '@nestjs/common';
import { ChannelDispatchService } from './channel-dispatch.service';
import { TelegramService } from './providers/telegram.provider';
import { SnsService } from './providers/sns.provider';
import { MailModule } from '../mail/mail.module';
import { TemplateModule } from '../template/template.module';
import { PrismaModule } from '../../database/prisma.module';

/**
 * ChannelModule — aggregates all notification delivery channels.
 *
 * Provides:
 *   - ChannelDispatchService (orchestrator)
 *   - TelegramService
 *   - SnsService (AWS SNS for SMS)
 *
 * The existing MailService is imported from MailModule.
 */
@Module({
  imports: [MailModule, TemplateModule, PrismaModule],
  providers: [ChannelDispatchService, TelegramService, SnsService],
  exports: [ChannelDispatchService, TelegramService, SnsService],
})
export class ChannelModule {}

import { Module } from '@nestjs/common';
import { ChannelDispatchService } from './channel-dispatch.service';
import { TelegramService } from './providers/telegram.provider';
import { TelegramMigrationService } from '../telegram/telegram-migration.service';
import { SnsService } from './providers/sns.provider';
import { MailModule } from '../mail/mail.module';
import { TemplateModule } from '../template/template.module';
import { PrismaModule } from '../../database/prisma.module';
import { RoutingModule } from '../routing/routing.module';

/**
 * ChannelModule — aggregates all notification delivery channels.
 *
 * Provides:
 *   - ChannelDispatchService (orchestrator)
 *   - TelegramService
 *   - TelegramMigrationService (custom-bot migration flow)
 *   - SnsService (AWS SNS for SMS)
 *
 * TelegramMigrationService lives here (not in TelegramModule) to avoid
 * a circular dependency: TelegramModule already imports ChannelModule.
 */
@Module({
  imports: [MailModule, TemplateModule, PrismaModule, RoutingModule],
  providers: [ChannelDispatchService, TelegramService, TelegramMigrationService, SnsService],
  exports: [ChannelDispatchService, TelegramService, TelegramMigrationService, SnsService],
})
export class ChannelModule {}

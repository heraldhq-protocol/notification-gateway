import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { QueueNames } from './queue.constants';
import { QueueService } from './queue.service';
import { MailWorker } from './workers/mail.worker';
import { DigestWorker } from './workers/digest.worker';
import { DigestService } from '../notify/digest.service';
import { RoutingModule } from '../routing/routing.module';
import { MailModule } from '../mail/mail.module';
import { TemplateModule } from '../template/template.module';
import { ChannelModule } from '../channel/channel.module';
import { WebhookModule } from '../webhook/webhook.module';
import { BillingModule } from '../billing/billing.module';

/**
 * QueueModule — registers all BullMQ queues and their workers.
 *
 * DigestService is co-located here (not in NotifyModule) to avoid
 * a circular dependency: NotifyModule → QueueModule → NotifyModule.
 * DigestService is fundamentally a queue concern — it buffers
 * notifications and flushes them via BullMQ.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: QueueNames.NOTIFICATION },
      { name: QueueNames.WEBHOOK },
      { name: QueueNames.BOUNCE },
      { name: QueueNames.DIGEST },
    ),
    ScheduleModule.forRoot(),
    RoutingModule,
    MailModule,
    TemplateModule,
    ChannelModule,
    WebhookModule,
    BillingModule,
  ],
  providers: [QueueService, MailWorker, DigestWorker, DigestService],
  exports: [QueueService, DigestService],
})
export class QueueModule {}

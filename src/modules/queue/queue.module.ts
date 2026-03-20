import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from './queue.constants.js';
import { QueueService } from './queue.service.js';
import { MailWorker } from './workers/mail.worker.js';
import { RoutingModule } from '../routing/routing.module.js';
import { MailModule } from '../mail/mail.module.js';
import { TemplateModule } from '../template/template.module.js';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QueueNames.NOTIFICATION },
      { name: QueueNames.RECEIPT_BATCH },
      { name: QueueNames.WEBHOOK },
      { name: QueueNames.BOUNCE },
      { name: QueueNames.DIGEST },
    ),
    RoutingModule,
    MailModule,
    TemplateModule,
  ],
  providers: [QueueService, MailWorker],
  exports: [QueueService],
})
export class QueueModule {}

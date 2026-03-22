import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from './queue.constants';
import { QueueService } from './queue.service';
import { MailWorker } from './workers/mail.worker';
import { RoutingModule } from '../routing/routing.module';
import { MailModule } from '../mail/mail.module';
import { TemplateModule } from '../template/template.module';

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
export class QueueModule { }

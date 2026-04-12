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
    // Only register queues with active processors.
    // RECEIPT_BATCH and DIGEST have no workers yet — registering idle queues
    // wastes ~170K Redis commands/day from heartbeat polling.
    BullModule.registerQueue(
      { name: QueueNames.NOTIFICATION },
      { name: QueueNames.WEBHOOK },
      { name: QueueNames.BOUNCE },
    ),
    RoutingModule,
    MailModule,
    TemplateModule,
  ],
  providers: [QueueService, MailWorker],
  exports: [QueueService],
})
export class QueueModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookWorker } from './webhook.worker';
import { QueueNames } from '../queue/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: QueueNames.WEBHOOK,
    }),
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookWorker],
  exports: [WebhookService],
})
export class WebhookModule { }

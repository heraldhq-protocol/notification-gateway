import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller.js';
import { WebhookService } from './webhook.service.js';
import { WebhookWorker } from './webhook.worker.js';
import { QueueNames } from '../queue/queue.constants.js';

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

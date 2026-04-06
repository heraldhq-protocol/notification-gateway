import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookWorker } from './webhook.worker';
import { QueueNames } from '../queue/queue.constants';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: QueueNames.WEBHOOK,
    }),
    AuthModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookWorker],
  exports: [WebhookService],
})
export class WebhookModule {}

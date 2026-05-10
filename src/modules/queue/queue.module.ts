import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from './queue.constants';
import { QueueService } from './queue.service';
import { DigestService } from '../notify/digest.service';

/**
 * QueueModule — registers BullMQ queues and provides queuing services.
 *
 * WARNING: Workers (MailWorker, DigestWorker) moved to WorkerModule
 * (worker.service) to eliminate event loop contention with the HTTP server.
 * They are NOT provided here — only QueueService (enqueue) and
 * DigestService (buffer + flush) remain in the web server's DI.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: QueueNames.NOTIFICATION },
      { name: QueueNames.WEBHOOK },
      { name: QueueNames.BOUNCE },
      { name: QueueNames.DIGEST },
    ),
  ],
  providers: [QueueService, DigestService],
  exports: [QueueService, DigestService],
})
export class QueueModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BounceController } from './bounce.controller.js';
import { BounceService } from './bounce.service.js';
import { BounceWorker } from './bounce.worker.js';
import { QueueNames } from '../queue/queue.constants.js';

@Module({
  imports: [
    BullModule.registerQueue({
      name: QueueNames.BOUNCE,
    }),
  ],
  controllers: [BounceController],
  providers: [BounceService, BounceWorker],
})
export class BounceModule { }

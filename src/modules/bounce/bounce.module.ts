import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BounceController } from './bounce.controller';
import { BounceService } from './bounce.service';
import { BounceWorker } from './bounce.worker';
import { QueueNames } from '../queue/queue.constants';

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

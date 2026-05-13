import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { SqsConsumerService } from './sqs.consumer.service';
import { QueueNames } from '../queue/queue.constants';

@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({ name: QueueNames.BOUNCE }),
  ],
  providers: [SqsConsumerService],
})
export class SqsModule {}

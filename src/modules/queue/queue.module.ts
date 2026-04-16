import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from './queue.constants';
import { QueueService } from './queue.service';
import { MailWorker } from './workers/mail.worker';
import { RoutingModule } from '../routing/routing.module';
import { MailModule } from '../mail/mail.module';
import { TemplateModule } from '../template/template.module';
import { ChannelModule } from '../channel/channel.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QueueNames.NOTIFICATION },
      { name: QueueNames.WEBHOOK },
      { name: QueueNames.BOUNCE },
    ),
    RoutingModule,
    MailModule,
    TemplateModule,
    ChannelModule,
  ],
  providers: [QueueService, MailWorker],
  exports: [QueueService],
})
export class QueueModule {}

import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller.js';
import { NotifyService } from './notify.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { QueueModule } from '../queue/queue.module.js';

@Module({
  imports: [AuthModule, RoutingModule, QueueModule],
  controllers: [NotifyController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule {}

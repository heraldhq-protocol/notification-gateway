import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { AuthModule } from '../auth/auth.module';
import { RoutingModule } from '../routing/routing.module';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../billing/billing.module';


@Module({
  imports: [AuthModule, RoutingModule, QueueModule, BillingModule],
  controllers: [NotifyController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class NotifyModule { }

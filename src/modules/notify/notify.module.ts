import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { AuthModule } from '../auth/auth.module';
import { RoutingModule } from '../routing/routing.module';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../billing/billing.module';
import { RateLimitInterceptor } from '../../common/interceptors/rate-limit.interceptor';

@Module({
  imports: [AuthModule, RoutingModule, QueueModule, BillingModule],
  controllers: [NotifyController],
  // SandboxService is provided globally via @Global() SandboxModule (imported in AppModule).
  // SandboxRoutingService is exported from RoutingModule — available via the RoutingModule import.
  providers: [NotifyService, RateLimitInterceptor],
  exports: [NotifyService],
})
export class NotifyModule {}

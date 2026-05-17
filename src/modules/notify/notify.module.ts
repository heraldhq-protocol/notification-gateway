import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { UnsubscribeController } from './unsubscribe.controller';
import { UnsubscribeService } from './unsubscribe.service';
import { AuthModule } from '../auth/auth.module';
import { RoutingModule } from '../routing/routing.module';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../billing/billing.module';
import { TemplateModule } from '../template/template.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RateLimitInterceptor } from '../../common/interceptors/rate-limit.interceptor';

@Module({
  imports: [
    AuthModule,
    RoutingModule,
    QueueModule, // Provides DigestService via exports
    BillingModule,
    TemplateModule,
    SubscriptionsModule,
  ],
  controllers: [NotifyController, UnsubscribeController],
  // SandboxService is provided globally via @Global() SandboxModule (imported in AppModule).
  // SandboxRoutingService is exported from RoutingModule — available via the RoutingModule import.
  // DigestService is provided by QueueModule (co-located there to avoid circular dependency).
  providers: [NotifyService, UnsubscribeService, RateLimitInterceptor],
  exports: [NotifyService, UnsubscribeService],
})
export class NotifyModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { SchedulerService } from './scheduler.service';
import { UnsubscribeController } from './unsubscribe.controller';
import { PortalUnsubscribeController } from './portal-unsubscribe.controller';
import { UnsubscribeService } from './unsubscribe.service';
import { AuthModule } from '../auth/auth.module';
import { RoutingModule } from '../routing/routing.module';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../billing/billing.module';
import { TemplateModule } from '../template/template.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RateLimitInterceptor } from '../../common/interceptors/rate-limit.interceptor';
import { QueueNames } from '../queue/queue.constants';
import { ContentScannerService } from './content-scanner.service';
import { AiClassifierService } from './ai-classifier.service';

@Module({
  imports: [
    AuthModule,
    RoutingModule,
    QueueModule, // Provides DigestService via exports
    BillingModule,
    TemplateModule,
    SubscriptionsModule,
    // SchedulerService injects the NOTIFICATION queue directly via @InjectQueue
    BullModule.registerQueue({ name: QueueNames.NOTIFICATION }),
  ],
  controllers: [NotifyController, UnsubscribeController, PortalUnsubscribeController],
  // SandboxService is provided globally via @Global() SandboxModule (imported in AppModule).
  // SandboxRoutingService is exported from RoutingModule — available via the RoutingModule import.
  // DigestService is provided by QueueModule (co-located there to avoid circular dependency).
  providers: [
    NotifyService,
    UnsubscribeService,
    RateLimitInterceptor,
    SchedulerService,
    ContentScannerService,
    AiClassifierService,
  ],
  exports: [NotifyService, UnsubscribeService, SchedulerService],
})
export class NotifyModule {}

import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsService } from './analytics.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [AuthModule, SubscriptionsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

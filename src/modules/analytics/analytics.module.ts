import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}

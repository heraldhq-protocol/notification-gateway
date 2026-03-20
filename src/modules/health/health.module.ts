import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
// import { MetricsController } from './metrics.controller.js';

@Module({
  controllers: [HealthController],
  // exports: [MetricsController],
})
export class HealthModule { }

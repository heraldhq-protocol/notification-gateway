import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';

import { loadConfiguration } from './config/configuration.js';
import { PrismaModule } from './database/prisma.module.js';

// Feature modules
import { AuthModule } from './modules/auth/auth.module.js';
import { NotifyModule } from './modules/notify/notify.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { WebhookModule } from './modules/webhook/webhook.module.js';
import { BounceModule } from './modules/bounce/bounce.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { ProtocolModule } from './modules/protocol/protocol.module.js';
import { DomainModule } from './modules/domain/domain.module.js';
import { ReceiptModule } from './modules/receipt/receipt.module.js';
import { SolanaModule } from './solana/solana.module.js';
import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { MetricsController } from './modules/health/metrics.controller.js';

/**
 * AppModule — root composition module for Herald Notification Gateway.
 *
 * Wires all feature modules, infrastructure (Prisma, Redis, BullMQ),
 * and global config together.
 */
@Module({
  imports: [
    // ── Global Config ─────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadConfiguration],
    }),

    // ── Database (PostgreSQL via Prisma) ──────────────────────
    PrismaModule,

    // ── BullMQ (Redis-backed queues) ──────────────────────────
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: {
          host: new URL(
            config.get<string>('REDIS_URL', 'redis://localhost:6379'),
          ).hostname,
          port: parseInt(
            new URL(config.get<string>('REDIS_URL', 'redis://localhost:6379'))
              .port || '6379',
            10,
          ),
        },
      }),
      inject: [ConfigService],
    }),

    // ── Feature Modules ───────────────────────────────────────
    AuthModule,
    HealthModule,
    NotifyModule,
    WebhookModule,
    BounceModule,
    AnalyticsModule,
    ProtocolModule,
    DomainModule,
    ReceiptModule,
    SolanaModule,
    LoggerModule.forRoot({
      pinoHttp: {
        transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
        autoLogging: {
          ignore: (req) => ['/health', '/metrics'].includes(req.url || ''),
        },
      },
    }),
    PrometheusModule.register({
      controller: MetricsController,
    }),
  ],

  providers: [
    // ── Redis Client (shared) ─────────────────────────────────
    {
      provide: Redis,
      useFactory: (config: ConfigService) =>
        new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          retryStrategy(times) {
            return Math.min(times * 200, 5000);
          },
        }),
      inject: [ConfigService],
    },
  ],

  exports: [Redis],
})
export class AppModule { }

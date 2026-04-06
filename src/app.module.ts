import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';

import { loadConfiguration } from './config/configuration';
import { PrismaModule } from './database/prisma.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { NotifyModule } from './modules/notify/notify.module';
import { HealthModule } from './modules/health/health.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { BounceModule } from './modules/bounce/bounce.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ProtocolModule } from './modules/protocol/protocol.module';
import { DomainModule } from './modules/domain/domain.module';
import { ReceiptModule } from './modules/receipt/receipt.module';
import { SolanaModule } from './solana/solana.module';
import { BillingModule } from './modules/billing/billing.module';

import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { MetricsController } from './modules/health/metrics.controller';
import { RedisModule } from './modules/redis/redis.module';

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

    // ── Redis ─────────────────────────────────────────────────
    RedisModule,

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
    BillingModule,
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty' }
            : undefined,
        autoLogging: {
          ignore: (req) => ['/health', '/metrics'].includes(req.url || ''),
        },
      },
    }),
    PrometheusModule.register({
      controller: MetricsController,
    }),
  ],
})
export class AppModule {}

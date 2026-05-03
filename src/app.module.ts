import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { loadConfiguration } from './config/configuration';
import { PrismaModule } from './database/prisma.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { NotifyModule } from './modules/notify/notify.module';
import { HealthModule } from './modules/health/health.module';
import { StatusModule } from './modules/status/status.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { BounceModule } from './modules/bounce/bounce.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ProtocolModule } from './modules/protocol/protocol.module';
import { DomainModule } from './modules/domain/domain.module';
import { ReceiptModule } from './modules/receipt/receipt.module';
import { SolanaModule } from './solana/solana.module';
import { BillingModule } from './modules/billing/billing.module';
import { AdminModule } from './modules/admin/admin.module';
import { RoutingModule } from './modules/routing/routing.module';
import { ChannelModule } from './modules/channel/channel.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';
import { EnclaveModule } from './modules/enclave/enclave.module';

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
      load: [loadConfiguration],
      cache: true,
    }),

    // ── Database (PostgreSQL via Prisma) ──────────────────────
    PrismaModule,

    // ── Redis ─────────────────────────────────────────────────
    RedisModule,

    // ── BullMQ (Redis-backed queues) ──────────────────────────
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        let redisUrl = config.get<string>(
          'REDIS_URL',
          'redis://localhost:6379',
        );

        // Sanitize: strip trailing comments and whitespace
        redisUrl = redisUrl.split('#')[0].trim();

        const connectionOptions: any = {
          maxRetriesPerRequest: null, // Required for BullMQ
        };

        // Case 1: Full Redis URL (Upstash, Heroku, etc.)
        if (
          redisUrl.startsWith('redis://') ||
          redisUrl.startsWith('rediss://')
        ) {
          const url = new URL(redisUrl);
          connectionOptions.host = url.hostname;
          connectionOptions.port = parseInt(url.port || '6379', 10);
          if (url.password) {
            connectionOptions.password = decodeURIComponent(url.password);
          }
          if (url.username) {
            connectionOptions.username = decodeURIComponent(url.username);
          }
          if (redisUrl.startsWith('rediss://')) {
            connectionOptions.tls = {};
          }
        }
        // Case 2: Raw hostname (AWS ElastiCache, etc.)
        else {
          const enableTls =
            redisUrl.includes('amazonaws.com') ||
            redisUrl.includes('upstash.io');

          connectionOptions.host = redisUrl;
          connectionOptions.port = 6379;
          if (enableTls) {
            connectionOptions.tls = {};
          }
        }

        return {
          connection: connectionOptions,
          // Reduce Redis command volume from BullMQ polling
          defaultJobOptions: {
            removeOnComplete: { age: 3600 }, // Remove completed after 1hr (not by count)
            removeOnFail: { age: 86400 }, // Keep failures 24hr for debugging
          },
        };
      },
      inject: [ConfigService],
    }),

    // ── Feature Modules ───────────────────────────────────────
    SandboxModule,
    AuthModule,
    HealthModule,
    StatusModule,
    NotifyModule,
    WebhookModule,
    BounceModule,
    AnalyticsModule,
    ProtocolModule,
    DomainModule,
    ReceiptModule,
    SolanaModule,
    BillingModule,
    AdminModule,
    RoutingModule,
    ChannelModule,
    EnclaveModule,
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

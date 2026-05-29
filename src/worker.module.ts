import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import { loadConfiguration } from './config/configuration';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './modules/redis/redis.module';

// Feature modules
import { QueueModule } from './modules/queue/queue.module';
import { RoutingModule } from './modules/routing/routing.module';
import { ChannelModule } from './modules/channel/channel.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { BillingModule } from './modules/billing/billing.module';
import { ArweaveStorageModule } from './storage/arweave-storage.module';
import { BounceModule } from './modules/bounce/bounce.module';
import { SqsModule } from './modules/sqs/sqs.module';
import { ReceiptModule } from './modules/receipt/receipt.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';

// Workers explicitly provided here (removed from QueueModule)
import { MailWorker } from './modules/queue/workers/mail.worker';
import { DigestWorker } from './modules/queue/workers/digest.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfiguration],
      cache: true,
    }),
    PrismaModule,
    RedisModule,
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        let redisUrl = config.get<string>(
          'REDIS_URL',
          'redis://localhost:6379',
        );
        redisUrl = redisUrl.split('#')[0].trim();
        const connectionOptions: any = {
          maxRetriesPerRequest: null, // Required for BullMQ — commands wait in offline queue
          connectTimeout: 10_000, // 10s TCP connect timeout; fail fast, don't hang
          retryStrategy: (times: number) => {
            return Math.min(times * 200, 10_000);
          },
        };
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
        } else {
          const configTls = config.get<boolean>('REDIS_TLS');
          const enableTls =
            configTls !== undefined
              ? configTls
              : redisUrl.includes('cache.amazonaws.com') ||
                redisUrl.includes('upstash.io');
          connectionOptions.host = redisUrl;
          connectionOptions.port = 6379;
          if (enableTls) {
            connectionOptions.tls = {};
          }
        }
        return {
          connection: connectionOptions,
          defaultJobOptions: {
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 86400 },
          },
        };
      },
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty' }
            : undefined,
        level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
        autoLogging: {
          ignore: (req) => ['/health', '/metrics'].includes(req.url || ''),
        },
      },
    }),
    QueueModule,
    RoutingModule,
    ChannelModule,
    WebhookModule,
    BillingModule,
    ArweaveStorageModule,
    BounceModule,
    SqsModule,
    ReceiptModule,
    SandboxModule,
  ],
  providers: [MailWorker, DigestWorker],
})
export class WorkerModule {}

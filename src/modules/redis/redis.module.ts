import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        let redisUrl = configService.getOrThrow<string>('REDIS_URL');

        // Sanitize: strip trailing comments and whitespace
        if (redisUrl && typeof redisUrl === 'string') {
          redisUrl = redisUrl.split('#')[0].trim();
        }

        // If REDIS_URL is a full Upstash-style URL, pass it directly to ioredis
        if (
          redisUrl?.startsWith('redis://') ||
          redisUrl?.startsWith('rediss://')
        ) {
          return new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
        }

        const isCluster =
          configService.get<boolean>('REDIS_CLUSTER_MODE') ||
          redisUrl.includes('clustercfg');

        const configTls = configService.get<boolean>('REDIS_TLS');
        const enableTls =
          configTls !== undefined
            ? configTls
            : redisUrl.includes('amazonaws.com') ||
              redisUrl.includes('upstash.io');

        const options = {
          host: redisUrl,
          port: 6379,
          ...(enableTls && { tls: {} }),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        };

        console.log(
          `[RedisModule] Connecting to ${options.host}:${options.port} (TLS: ${!!options.tls}, Cluster: ${isCluster})`,
        );

        const client = isCluster
          ? new Redis.Cluster([{ host: redisUrl, port: 6379 }], {
              redisOptions: options,
            })
          : new Redis(options);

        client.on('error', (err) => {
          console.error(
            `[RedisModule] Redis connection error: ${err.message}`,
            {
              host: options.host,
              tls: !!options.tls,
            },
          );
        });

        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

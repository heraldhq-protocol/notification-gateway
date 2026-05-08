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

        // Strip trailing inline comments (e.g. "host:6379 #added from AWS")
        if (typeof redisUrl === 'string') {
          redisUrl = redisUrl.split('#')[0].trim();
        }

        // Full URL path — rediss:// or redis://
        if (
          redisUrl.startsWith('rediss://') ||
          redisUrl.startsWith('redis://')
        ) {
          return new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
        }

        // Bare host or host:port — parse into parts
        let host = redisUrl;
        let port = 6379;
        if (redisUrl.includes(':')) {
          const [h, p] = redisUrl.split(':');
          host = h;
          port = parseInt(p, 10) || 6379;
        }

        const isCluster =
          configService.get<boolean>('REDIS_CLUSTER_MODE') ||
          redisUrl.includes('clustercfg');

        // Enable TLS for ElastiCache (encryption in transit required) and Upstash.
        // Can be overridden explicitly with REDIS_TLS=true/false.
        const configTls = configService.get<string>('REDIS_TLS');
        const enableTls =
          configTls !== undefined
            ? configTls === 'true'
            : host.includes('cache.amazonaws.com') ||
              host.includes('upstash.io');

        const options = {
          host,
          port,
          ...(enableTls && { tls: { rejectUnauthorized: false } }),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        };

        console.log(
          `[RedisModule] Connecting to ${options.host}:${options.port} (TLS: ${!!options.tls}, Cluster: ${isCluster})`,
        );

        const client = isCluster
          ? new Redis.Cluster([{ host, port }], { redisOptions: options })
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

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

        const isCluster = redisUrl.includes('clustercfg');
        const enableTls =
          redisUrl.includes('amazonaws.com') || redisUrl.includes('upstash.io');

        const options = {
          host: redisUrl,
          port: 6379,
          ...(enableTls && { tls: {} }),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        };

        // If sharding (Cluster Mode Enabled) is active
        if (isCluster) {
          return new Redis.Cluster([{ host: redisUrl, port: 6379 }], {
            redisOptions: options,
          });
        }

        // Standalone or Cluster Mode Disabled Master Node
        return new Redis(options);
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

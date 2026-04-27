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
        let redisUrl = configService.get<string>('REDIS_URL', 'redis://localhost:6379');
        console.log(`[RedisModule] Initializing with REDIS_URL: ${redisUrl ? 'present' : 'MISSING'}`);

        if (!redisUrl) {
          console.warn('[RedisModule] REDIS_URL not configured, using default localhost:6379');
          return new Redis('redis://localhost:6379', {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
        }

        redisUrl = redisUrl.split('#')[0].trim();

        if (redisUrl.startsWith('redis://') || redisUrl.startsWith('rediss://')) {
          console.log(`[RedisModule] Using direct URL (Upstash style)`);
          return new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
        }

        const isCluster = redisUrl.includes('clustercfg');
        const enableTls = redisUrl.includes('amazonaws.com') || redisUrl.includes('upstash.io');

        console.log(`[RedisModule] Parsing as host:port (cluster=${isCluster}, tls=${enableTls})`);

        const options = {
          host: redisUrl,
          port: 6379,
          ...(enableTls && { tls: {} }),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        };

        if (isCluster) {
          return new Redis.Cluster([{ host: redisUrl, port: 6379 }], {
            redisOptions: options,
          });
        }

        return new Redis(options);
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

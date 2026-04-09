import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global() // Makes Redis available everywhere without importing
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        const isSecure = url.startsWith('rediss://');

        return new Redis(url, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          tls: isSecure ? {} : undefined,
          retryStrategy(times) {
            return Math.min(times * 200, 5000);
          },
        });
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}

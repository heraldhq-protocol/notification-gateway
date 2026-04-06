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
        return new Redis(
          config.get<string>('REDIS_URL', 'redis://localhost:6379'),
          {
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            retryStrategy(times) {
              return Math.min(times * 200, 5000);
            },
          },
        );
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}

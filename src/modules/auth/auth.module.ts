import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../../database/prisma.module';
import { UsageController } from './usage.controller';

@Module({
  imports: [RedisModule, PrismaModule],
  controllers: [UsageController],
  providers: [AuthService, RateLimitService],
  exports: [AuthService, RateLimitService],
})
export class AuthModule {}

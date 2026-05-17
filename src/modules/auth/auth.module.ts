import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../../database/prisma.module';
import { UsageController } from './usage.controller';
import { AuthController } from './auth.controller';

@Module({
  imports: [ConfigModule, RedisModule, PrismaModule],
  controllers: [UsageController, AuthController],
  providers: [AuthService, RateLimitService],
  exports: [AuthService, RateLimitService],
})
export class AuthModule {}

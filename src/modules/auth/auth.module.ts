import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { RateLimitService } from './rate-limit.service.js';

@Module({
  providers: [AuthService, RateLimitService],
  exports: [AuthService, RateLimitService],
})
export class AuthModule {}

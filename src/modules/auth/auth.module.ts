import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';

@Module({
  providers: [AuthService, RateLimitService],
  exports: [AuthService, RateLimitService],
})
export class AuthModule {}

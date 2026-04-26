import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RateLimitService } from './rate-limit.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

@ApiTags('Usage')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/usage')
export class UsageController {
  constructor(private readonly rateLimitService: RateLimitService) {}

  @Get()
  @ApiOperation({ summary: 'Get current month API usage and quota limits' })
  getUsage(@ApiKey() protocol: AuthenticatedProtocol) {
    const tier = protocol.tier;
    const limit = this.rateLimitService.getTierLimits(tier)?.sendsPerMonth ?? 0;

    // We get current usage by passing count=0 to the rate limiter script or querying Redis directly.
    // The RateLimitService.checkRateLimit method increments, so we need a checkOnly option or a separate usage call.
    // Since rate limiting uses Redis HINCBY, we can just read the key directly, but it's cleaner to query the service.

    const usage = Number(protocol.sendsThisPeriod || 0);

    return {
      tier,
      limit,
      usage,
      remaining: Math.max(0, limit - usage),
      overageEnabled: protocol.overageEnabled ?? false,
      resetAt: this.rateLimitService.getEndOfMonthTimestamp(),
    };
  }
}

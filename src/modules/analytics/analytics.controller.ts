import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

/**
 * AnalyticsController — delivery analytics and usage stats.
 */
@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Get delivery analytics overview' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['7d', '30d', '90d'],
    description: 'Analytics period',
  })
  async getAnalytics(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('period') period: '7d' | '30d' | '90d' = '30d',
  ) {
    return this.analyticsService.getAnalytics(protocol.protocolId, period);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Current period usage vs quota' })
  async getUsage(@ApiKey() protocol: AuthenticatedProtocol) {
    return this.analyticsService.getUsage(protocol.protocolId, protocol.tier);
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1')
@RequiredScopes('analytics:read')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Get delivery analytics overview' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d'] })
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

  @Get('requests')
  @ApiOperation({ summary: 'API request inspector — paginated request logs' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'statusCode', required: false, type: Number })
  @ApiQuery({ name: 'endpoint', required: false, type: String })
  @ApiQuery({ name: 'isTestKey', required: false, type: Boolean })
  async getRequestLogs(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('statusCode') statusCode?: string,
    @Query('endpoint') endpoint?: string,
    @Query('isTestKey') isTestKey?: string,
  ) {
    return this.analyticsService.getRequestLogs(protocol.protocolId, {
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), 100),
      statusCode: statusCode ? parseInt(statusCode, 10) : undefined,
      endpoint,
      isTestKey: isTestKey === 'true' ? true : isTestKey === 'false' ? false : undefined,
    });
  }
}

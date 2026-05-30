import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

// 1×1 transparent GIF bytes
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

@ApiTags('Analytics')
@Controller('v1')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('track/open/:notificationId')
  @ApiOperation({ summary: 'Email open tracking pixel (public)' })
  trackOpen(
    @Param('notificationId') notificationId: string,
    @Query('p') protocolId: string,
    @Res() res: Response,
  ) {
    // Fire-and-forget — never block the email client
    if (notificationId && protocolId) {
      this.analyticsService
        .recordEngagement(notificationId, protocolId, 'open')
        .catch(() => {});
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.send(TRACKING_PIXEL);
  }

  @Get('track/click/:notificationId')
  @ApiOperation({
    summary: 'Click-wrap redirect with engagement tracking (public)',
  })
  trackClick(
    @Param('notificationId') notificationId: string,
    @Query('p') protocolId: string,
    @Query('url') encodedUrl: string,
    @Res() res: Response,
  ) {
    let destination = 'https://useherald.xyz';
    try {
      destination = Buffer.from(encodedUrl, 'base64url').toString('utf8');
    } catch (_) {
      /* ignore malformed base64url */
    }

    if (notificationId && protocolId) {
      this.analyticsService
        .recordEngagement(notificationId, protocolId, 'click', destination)
        .catch(() => {});
    }
    res.redirect(302, destination);
  }

  @Get('analytics')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('analytics:read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get delivery analytics overview' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d'] })
  async getAnalytics(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('period') period: '7d' | '30d' | '90d' = '30d',
  ) {
    return this.analyticsService.getAnalytics(protocol.protocolId, period);
  }

  @Get('usage')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('analytics:read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current period usage vs quota' })
  async getUsage(@ApiKey() protocol: AuthenticatedProtocol) {
    return this.analyticsService.getUsage(protocol.protocolId, protocol.tier);
  }

  @Get('engagement')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('analytics:read')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Engagement metrics — open/click/unsubscribe rates',
  })
  async getEngagement(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('templateId') templateId?: string,
  ) {
    return this.analyticsService.getEngagementMetrics(
      protocol.protocolId,
      startDate,
      endDate,
      templateId,
    );
  }

  @Get('audience')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('analytics:read')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Audience analytics — subscription counts, channel coverage, registration trend',
  })
  async getAudienceAnalytics(@ApiKey() protocol: AuthenticatedProtocol) {
    return this.analyticsService.getAudienceAnalytics(protocol.protocolId);
  }

  @Get('analytics/telegram')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('analytics:read')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Telegram analytics — subscribers, delivery rate, click rate, top links',
  })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d'] })
  async getTelegramAnalytics(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Query('period') period: '7d' | '30d' | '90d' = '30d',
  ) {
    return this.analyticsService.getTelegramAnalytics(
      protocol.protocolId,
      period,
    );
  }

  @Get('requests')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('analytics:read')
  @ApiBearerAuth()
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
      isTestKey:
        isTestKey === 'true' ? true : isTestKey === 'false' ? false : undefined,
    });
  }
}

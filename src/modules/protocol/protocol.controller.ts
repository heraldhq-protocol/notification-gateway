import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProtocolService } from './protocol.service';
import { PrismaService } from '../../database/prisma.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

/**
 * ProtocolController — protocol self-service endpoints.
 */
@ApiTags('Protocol')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/protocols')
@RequiredScopes('protocol:read')
export class ProtocolController {
  constructor(
    private readonly protocolService: ProtocolService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get your protocol info + subscription status' })
  async getMe(@ApiKey() protocol: AuthenticatedProtocol) {
    const info = await this.protocolService.getProtocolInfo(
      protocol.protocolId,
    );
    if (!info) throw new NotFoundException('Protocol not found');
    return info;
  }

  @Get('me/retry-policy')
  @ApiOperation({ summary: 'Get retry + engagement tracking settings' })
  async getRetryPolicy(@ApiKey() protocol: AuthenticatedProtocol) {
    const settings = await this.prisma.protocolSettings.findUnique({
      where: { protocolId: protocol.protocolId },
      select: {
        retryMaxAttempts: true,
        retryWindowHours: true,
        retryBackoff: true,
        criticalCategories: true,
        trackEngagement: true,
      },
    });

    // Return defaults if no settings record exists yet
    return {
      retryMaxAttempts: settings?.retryMaxAttempts ?? 3,
      retryWindowHours: settings?.retryWindowHours ?? 6,
      retryBackoff: settings?.retryBackoff ?? 'exponential',
      criticalCategories: settings?.criticalCategories ?? [],
      trackEngagement: settings?.trackEngagement ?? false,
    };
  }

  @Patch('me/retry-policy')
  @ApiOperation({ summary: 'Update retry + engagement tracking settings' })
  async updateRetryPolicy(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Body() body: any,
  ) {
    const data: Record<string, unknown> = {};
    if (body.retryMaxAttempts !== undefined)
      data.retryMaxAttempts = Number(body.retryMaxAttempts);
    if (body.retryWindowHours !== undefined)
      data.retryWindowHours = Number(body.retryWindowHours);
    if (body.retryBackoff !== undefined)
      data.retryBackoff = String(body.retryBackoff);
    if (body.criticalCategories !== undefined)
      data.criticalCategories = Array.isArray(body.criticalCategories)
        ? body.criticalCategories
        : [];
    if (body.trackEngagement !== undefined)
      data.trackEngagement = Boolean(body.trackEngagement);

    const settings = await this.prisma.protocolSettings.upsert({
      where: { protocolId: protocol.protocolId },
      update: data,
      create: {
        protocolId: protocol.protocolId,
        retryMaxAttempts: (data.retryMaxAttempts as number) ?? 3,
        retryWindowHours: (data.retryWindowHours as number) ?? 6,
        retryBackoff: (data.retryBackoff as string) ?? 'exponential',
        criticalCategories: (data.criticalCategories as string[]) ?? [],
        trackEngagement: (data.trackEngagement as boolean) ?? false,
      },
      select: {
        retryMaxAttempts: true,
        retryWindowHours: true,
        retryBackoff: true,
        criticalCategories: true,
        trackEngagement: true,
      },
    });

    return settings;
  }
}

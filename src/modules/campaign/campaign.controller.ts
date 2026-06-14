import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/campaigns')
export class CampaignController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
  ) {}

  @Get()
  @RequiredScopes('notify:read')
  @ApiOperation({ summary: 'List all campaigns for the authenticated protocol' })
  async listCampaigns(@ApiKey() protocol: AuthenticatedProtocol) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { protocolId: protocol.protocolId },
      include: { audience: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.subject,
        status: c.status,
        audienceSize: c.audience?.walletCount ?? 0,
        sent: c.totalSent,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  @Post(':id/launch')
  @RequiredScopes('notify:write')
  @ApiOperation({ summary: 'Launch a draft or scheduled campaign' })
  async launchCampaign(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (campaign.status !== 'DRAFT' && campaign.status !== 'SCHEDULED') {
      throw new BadRequestException(
        `Cannot launch a campaign with status "${campaign.status}"`,
      );
    }

    const result = await this.adminService.enqueueCampaign(id);
    return { success: true, enqueued: result.enqueued };
  }

  @Post(':id/cancel')
  @RequiredScopes('notify:write')
  @ApiOperation({ summary: 'Cancel an active or pending campaign' })
  async cancelCampaign(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (campaign.status !== 'DRAFT' && campaign.status !== 'SCHEDULED') {
      throw new BadRequestException(
        `Cannot cancel a campaign with status "${campaign.status}"`,
      );
    }

    await this.prisma.campaign.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    return { success: true };
  }
}

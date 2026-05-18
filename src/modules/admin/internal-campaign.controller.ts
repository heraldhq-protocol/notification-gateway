import {
  Controller,
  Post,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { InternalGuard } from '../../common/guards/internal.guard';
import { AdminService } from './admin.service';

/**
 * InternalCampaignController — endpoints called by herald-admin-registration-api.
 * Protected by InternalGuard (x-internal-secret header).
 */
@ApiTags('Internal')
@UseGuards(InternalGuard)
@Controller('internal/campaigns')
export class InternalCampaignController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * POST /internal/campaigns/:id/enqueue
   *
   * Called by the admin-api after a campaign is launched.
   * Reads campaign + audience from the shared DB, creates one Notification row
   * per wallet, and enqueues one BullMQ job per wallet.
   */
  @Post(':id/enqueue')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Enqueue campaign notifications for all audience wallets',
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID' })
  @ApiResponse({ status: 202, description: 'Campaign enqueue started' })
  @ApiResponse({ status: 401, description: 'Invalid internal secret' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  async enqueueCampaign(
    @Param('id') id: string,
  ): Promise<{ campaignId: string; enqueued: number }> {
    return this.adminService.enqueueCampaign(id);
  }
}

import {
  Controller,
  Get,
  Post,
  Req,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { BillingService } from './billing.service';
import { HelioService } from './helio/helio.service';
import { SubscriptionService } from './subscription/subscription.service';
import { ProtocolService } from '../protocol/protocol.service';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('v1/billing')
@UseGuards(AuthGuard)
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly helioService: HelioService,
    private readonly subscriptionService: SubscriptionService,
    private readonly protocolService: ProtocolService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Get subscription status and usage for authenticated protocol',
  })
  async getStatus(@Req() req: any) {
    return this.billingService.getStatus(req.authProtocol.protocolId);
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Generate Helio checkout URL for subscription/upgrade',
  })
  async createCheckout(
    @Req() req: any,
    @Body() dto: { tier: number; months?: number },
  ) {
    const protocol = await this.protocolService.findById(
      req.authProtocol.protocolId,
    );
    if (!protocol) throw new Error('Protocol not found');

    const result = await this.helioService.createCheckoutUrl(
      protocol,
      dto.tier,
      dto.months ?? 1,
    );
    return { checkoutUrl: result.checkoutUrl, expiresAt: result.expiresAt };
  }

  @Post('cancel')
  @ApiOperation({
    summary: 'Cancel subscription at end of current billing period',
  })
  async cancelSubscription(@Req() req: any) {
    await this.subscriptionService.scheduleCancellation(
      req.authProtocol.protocolId,
    );
    return { message: 'Subscription will cancel at end of current period.' };
  }

  @Get('payments')
  @ApiOperation({ summary: 'List payment history for authenticated protocol' })
  async getPaymentHistory(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.billingService.getPaymentHistory(req.authProtocol.protocolId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Get('tiers')
  @ApiOperation({ summary: 'Get plan information for all tiers' })
  getTiers() {
    return this.billingService.getAllTierInfo();
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get current period usage stats' })
  async getUsage(@Req() req: any) {
    return this.billingService.getUsageStats(req.authProtocol.protocolId);
  }
}

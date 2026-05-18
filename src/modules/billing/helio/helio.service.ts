import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { HelioBilling } from '@herald-protocol/sdk/billing';
import type { HeraldTier, CheckoutResult } from '@herald-protocol/sdk/billing';
import * as crypto from 'crypto';
import { Protocol } from '../../../../prisma/generated/prisma/index';

@Injectable()
export class HelioService {
  private readonly helioBilling: HelioBilling;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.helioBilling = new HelioBilling({
      apiKey: config.getOrThrow<string>('HELIO_API_KEY'),
      secretKey: config.getOrThrow<string>('HELIO_SECRET_KEY'),
      network:
        config.get<string>('NODE_ENV') === 'production' ? 'mainnet' : 'devnet',
    });
  }

  private mapTierToHeraldTier(tier: number): HeraldTier {
    if (tier === 1) return 'growth';
    if (tier === 2) return 'scale';
    if (tier === 3) return 'enterprise';
    throw new BadRequestException('Invalid tier');
  }

  private getTemplateId(tier: number): string | undefined {
    if (tier === 1) return this.config.get<string>('HELIO_TEMPLATE_GROWTH');
    if (tier === 2) return this.config.get<string>('HELIO_TEMPLATE_SCALE');
    if (tier === 3) return this.config.get<string>('HELIO_TEMPLATE_ENTERPRISE');
    return undefined;
  }

  async createCheckoutUrl(
    protocol: Pick<Protocol, 'id' | 'protocolPubkey'>,
    tier: number,
    months: number = 1,
  ): Promise<CheckoutResult> {
    if (tier === 0) {
      throw new BadRequestException(
        'Developer tier is free — no checkout needed',
      );
    }

    this.logger.info('Creating Helio checkout', {
      protocolId: protocol.id,
      tier,
      months,
    });

    const heraldTier = this.mapTierToHeraldTier(tier);

    return this.helioBilling.createSubscriptionCheckout({
      tier: heraldTier,
      walletAddress: protocol.protocolPubkey,
      templateId: this.getTemplateId(tier),
      successUrl: `${this.config.get<string>('HELIO_CHECKOUT_SUCCESS_URL')}?tier=${tier}&months=${months}`,
      cancelUrl: this.config.get<string>('HELIO_CHECKOUT_CANCEL_URL')!,
      metadata: {
        protocol_id: protocol.id,
        months: months.toString(),
      },
    });
  }

  async cancelHelioSubscription(helioSubscriptionId: string): Promise<void> {
    this.logger.info('Helio subscription cancellation requested', {
      helioSubscriptionId,
    });

    try {
      const success =
        await this.helioBilling.cancelSubscription(helioSubscriptionId);
      if (!success) {
        this.logger.warn(
          `Failed to cancel Helio subscription ${helioSubscriptionId}`,
        );
      } else {
        this.logger.info(
          `Successfully cancelled Helio subscription ${helioSubscriptionId}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error attempting to cancel Helio subscription: ${error.message}`,
        error,
      );
    }
  }

  parseAndVerifyWebhook(rawBody: string, signature: string): boolean {
    const secret = this.config.getOrThrow<string>('HELIO_WEBHOOK_SECRET');
    const hmac = crypto.createHmac('sha256', secret);
    const digest = hmac.update(rawBody).digest('hex');
    return digest === signature;
  }
}

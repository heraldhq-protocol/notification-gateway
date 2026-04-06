import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import {
  HelioClient,
  HelioCheckoutResult,
  HelioWebhookPayload,
  HelioSubscriptionTemplate,
} from '@herald-protocol/sdk/billing';
import { Protocol } from '../../../../prisma/generated/prisma/index';

@Injectable()
export class HelioService {
  private readonly helioClient: HelioClient;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.helioClient = new HelioClient({
      apiKey: config.getOrThrow<string>('HELIO_API_KEY'),
      webhookSecret: config.getOrThrow<string>('HELIO_WEBHOOK_SECRET'),
      templates: {
        1: config.getOrThrow<string>('HELIO_TEMPLATE_GROWTH'),
        2: config.getOrThrow<string>('HELIO_TEMPLATE_SCALE'),
        3: config.getOrThrow<string>('HELIO_TEMPLATE_ENTERPRISE'),
      },
    });
  }

  async createCheckoutUrl(
    protocol: Pick<Protocol, 'id' | 'protocolPubkey'>,
    tier: number,
    months: number = 1,
  ): Promise<HelioCheckoutResult> {
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

    const templateId = this.config.getOrThrow<string>(
      tier === 1
        ? 'HELIO_TEMPLATE_GROWTH'
        : tier === 2
          ? 'HELIO_TEMPLATE_SCALE'
          : 'HELIO_TEMPLATE_ENTERPRISE',
    );

    return this.helioClient.createCheckoutUrl({
      templateId,
      tier: tier as any,
      protocolPubkey: protocol.protocolPubkey,
      protocolId: protocol.id,
      months,
      successUrl: `${this.config.get<string>('HELIO_CHECKOUT_SUCCESS_URL')}?tier=${tier}&months=${months}`,
      cancelUrl: this.config.get<string>('HELIO_CHECKOUT_CANCEL_URL')!,
    });
  }

  parseAndVerifyWebhook(
    rawBody: string,
    signature: string,
  ): HelioWebhookPayload | null {
    try {
      return this.helioClient.parseWebhook(rawBody, signature);
    } catch {
      return null;
    }
  }

  async getSubscriptionTemplates(): Promise<HelioSubscriptionTemplate[]> {
    return this.helioClient.fetchSubscriptionTemplates();
  }

  async cancelHelioSubscription(helioSubscriptionId: string): Promise<void> {
    await this.helioClient.cancelSubscription(helioSubscriptionId);
    this.logger.info('Helio subscription cancelled', { helioSubscriptionId });
  }
}

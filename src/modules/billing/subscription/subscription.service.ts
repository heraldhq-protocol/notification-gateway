import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../../database/prisma.service';
import { OnChainRenewalService } from '../onchain/renewal.service';
import { HelioService } from '../helio/helio.service';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { PaymentRepository } from '../repositories/payment.repository';
import { HelioEventRepository } from '../repositories/helio-event.repository';
import { MailService } from '../../mail/mail.service';
import { TemplateService } from '../../template/template.service';
import type { HelioWebhookPayload } from '../helio/helio.types';
import { PublicKey } from '@solana/web3.js';
import { Protocol } from '../../../../prisma/generated/prisma/index';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onChainRenewalService: OnChainRenewalService,
    private readonly helioService: HelioService,
    private readonly subscriptionRepo: SubscriptionRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly helioEventRepo: HelioEventRepository,
    private readonly mailService: MailService,
    private readonly templateService: TemplateService,
    private readonly logger: PinoLogger,
  ) {}

  async activateFromHelioPayment(payload: HelioWebhookPayload): Promise<void> {
    const {
      protocolPubkey,
      tier,
      months,
      amountUsdc,
      solanaTxSignature,
      transactionId,
    } = payload;

    const tierInt = Number(tier);
    const monthsInt = Number(months || 1);
    const amountUsdcBigInt = BigInt(Math.floor(Number(amountUsdc || 0)));

    const protocol = await this.prisma.protocol.findUnique({
      where: { protocolPubkey },
    });
    if (!protocol)
      throw new Error(`Protocol not found for pubkey ${protocolPubkey}`);
    const protocolId = protocol.id;

    this.logger.info('Activating subscription from Helio payment', {
      protocolId,
      tier: tierInt,
      months: monthsInt,
    });

    try {
      const renewalTx = await this.onChainRenewalService.renewSubscription(
        new PublicKey(protocolPubkey),
      );
      this.logger.info('On-chain renewal confirmed', { txSig: renewalTx });
    } catch (e) {
      this.logger.error(
        'On-chain renewal failed, but proceeding with DB update',
        { error: e.message },
      );
      // We still update the DB if on-chain fails, can be manually synced later
    }

    const now = new Date();
    const periodEnd = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000 * monthsInt,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.upsert({
        where: { protocolId },
        create: {
          protocolId,
          tier: tierInt,
          status: 'active',
          helioSubscriptionId: transactionId, // Using transactionId as substitute if subId isn't separated
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          sendsThisPeriod: 0n,
          periodResetAt: periodEnd,
          cancelAtPeriodEnd: false,
        },
        update: {
          tier: tierInt,
          status: 'active',
          helioSubscriptionId: transactionId,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          sendsThisPeriod: 0n,
          periodResetAt: periodEnd,
          cancelAtPeriodEnd: false,
        },
      });

      await tx.payment.create({
        data: {
          protocolId,
          amountUsdc: amountUsdcBigInt,
          tokenSymbol: 'USDC',
          paymentSource: 'helio',
          helioTransactionId: transactionId,
          solanaTxSignature,
          periodsPaid: monthsInt,
          periodStart: now,
          periodEnd,
          status: 'completed',
        },
      });

      await tx.protocol.update({
        where: { id: protocolId },
        data: {
          tier: tierInt,
          isActive: true,
          updatedAt: now,
        },
      });

      await tx.helioWebhookEvent.update({
        where: { helioEventId: transactionId },
        data: { processed: true, processedAt: now },
      });
    });

    this.sendSubscriptionConfirmationEmail(protocol, tierInt, monthsInt).catch(
      (e) =>
        this.logger.warn('Confirmation email failed (non-critical)', {
          error: e.message,
        }),
    );

    this.logger.info('Subscription activated successfully', {
      protocolId,
      tier: tierInt,
      months: monthsInt,
    });
  }

  async syncFromOnChain(protocolPubkey: string): Promise<void> {
    await Promise.resolve();

    // A simplified version of sync to be fleshed out in event-listener
    this.logger.info('Syncing protocol from on-chain event', {
      protocolPubkey,
    });
  }

  async scheduleCancellation(protocolId: string): Promise<void> {
    await this.subscriptionRepo.update(protocolId, { cancelAtPeriodEnd: true });
    this.logger.info('Subscription cancellation scheduled', { protocolId });

    const sub = await this.subscriptionRepo.findByProtocolId(protocolId);
    if (sub?.helioSubscriptionId) {
      await this.helioService
        .cancelHelioSubscription(sub.helioSubscriptionId)
        .catch(console.error);
    }
  }

  async expireStaleSubscriptions(): Promise<number> {
    const expired = await this.subscriptionRepo.findExpired();
    let count = 0;

    for (const sub of expired) {
      try {
        await this.subscriptionRepo.update(sub.protocolId, {
          status: 'expired',
        });
        await this.prisma.protocol.update({
          where: { id: sub.protocolId },
          data: { isActive: false },
        });

        this.onChainRenewalService
          .deactivateProtocol(sub.protocol.protocolPubkey)
          .catch((e) =>
            this.logger.warn('On-chain deactivation failed', {
              error: e.message,
            }),
          );

        count++;
      } catch (e) {
        this.logger.error('Failed to expire subscription', {
          protocolId: sub.protocolId,
          error: e.message,
        });
      }
    }

    if (count > 0) this.logger.info(`Expired ${count} stale subscriptions`);
    return count;
  }

  private async sendSubscriptionConfirmationEmail(
    _protocol: Protocol,
    _tier: number,
    _months: number,
  ): Promise<void> {
    // Protocol requires an admin email to send this. For this implementation we'll mock or skip.
    // Assuming adminEmail exists or we skip.
    return Promise.resolve();
  }
}

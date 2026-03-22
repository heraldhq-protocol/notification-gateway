import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import { SubscriptionService } from './subscription.service';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { PrismaService } from '../../../database/prisma.service';
import { OnChainRenewalService } from '../onchain/renewal.service';

@Injectable()
export class SubscriptionScheduler {
    constructor(
        private readonly subscriptionService: SubscriptionService,
        private readonly subscriptionRepo: SubscriptionRepository,
        private readonly prisma: PrismaService,
        private readonly onChainRenewalService: OnChainRenewalService,
        private readonly logger: PinoLogger,
    ) { }

    @Cron(CronExpression.EVERY_HOUR)
    async expireStaleSubscriptions(): Promise<void> {
        const count = await this.subscriptionService.expireStaleSubscriptions();
        if (count > 0) this.logger.info(`Cron: expired ${count} subscriptions`);
    }

    @Cron('0 0 * * *')
    async resetPeriodSends(): Promise<void> {
        const toReset = await this.subscriptionRepo.findDueForReset();
        let count = 0;

        for (const sub of toReset) {
            try {
                await this.subscriptionRepo.resetSends(sub.protocolId);
                await this.onChainRenewalService.resetProtocolSends(sub.protocol.protocolPubkey);
                count++;
            } catch (e) {
                this.logger.error('Failed to reset period sends', { protocolId: sub.protocolId, error: e.message });
            }
        }

        if (count > 0) this.logger.info(`Cron: reset sends for ${count} protocols`);
    }

    // Cron for usage warning and renewal reminders can be added similarly
    // ...
}

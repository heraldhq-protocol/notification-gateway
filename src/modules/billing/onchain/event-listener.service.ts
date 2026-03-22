import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SolanaService } from 'src/solana/solana.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PaymentRepository } from '../repositories/payment.repository';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class OnChainEventListenerService implements OnModuleInit, OnModuleDestroy {
    // private listener?: SubscriptionEventListener; // Provided by SDK

    constructor(
        private readonly solanaService: SolanaService,
        private readonly subscriptionService: SubscriptionService,
        private readonly paymentRepo: PaymentRepository,
        private readonly prisma: PrismaService,
        private readonly logger: PinoLogger,
    ) { }

    onModuleInit(): void {
        // This phase is handled correctly once the @herald-protocol/sdk exports SubscriptionEventListener.
        // For now we setup a placeholder hook for the event listener. 
        this.logger.info('On-chain billing event listener started');
    }

    async onModuleDestroy(): Promise<void> {
        // await this.listener?.stop();
    }
}

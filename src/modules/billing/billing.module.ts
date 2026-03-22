import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module.js';
import { SolanaModule } from '../../solana/solana.module.js';
// Add Mail and Protocol if needed. We might need them for email confirmations.
import { MailModule } from '../mail/mail.module.js';
import { ProtocolModule } from '../protocol/protocol.module.js';
import { TemplateModule } from '../template/template.module.js';
import { AuthModule } from '../auth/auth.module.js';


import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

import { HelioService } from './helio/helio.service.js';
import { HelioWebhookController } from './helio/helio.webhook.controller.js';

import { SubscriptionService } from './subscription/subscription.service.js';
import { SubscriptionGuard } from './subscription/subscription.guard.js';
import { SubscriptionScheduler } from './subscription/subscription.scheduler.js';

import { OnChainRenewalService } from './onchain/renewal.service.js';
import { OnChainEventListenerService } from './onchain/event-listener.service.js';

import { SubscriptionRepository } from './repositories/subscription.repository.js';
import { PaymentRepository } from './repositories/payment.repository.js';
import { HelioEventRepository } from './repositories/helio-event.repository.js';

@Module({
    imports: [
        AuthModule,
        PrismaModule,
        MailModule,
        ProtocolModule,
        TemplateModule,
        BullModule.registerQueue(
            { name: 'billing-webhooks' }
        ),
        ScheduleModule.forRoot(),
        SolanaModule,
    ],
    controllers: [
        BillingController,
        HelioWebhookController,
    ],
    providers: [
        BillingService,
        HelioService,
        SubscriptionService,
        OnChainRenewalService,
        OnChainEventListenerService,
        SubscriptionScheduler,
        SubscriptionGuard,
        SubscriptionRepository,
        PaymentRepository,
        HelioEventRepository,
    ],
    exports: [
        BillingService,
        SubscriptionService,
        SubscriptionGuard,
        SubscriptionRepository,
        HelioService,
    ],
})
export class BillingModule { }

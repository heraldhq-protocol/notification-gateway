import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueNames } from '../queue/queue.constants';
import { PrismaService } from '../../database/prisma.service';

export interface WebhookPayload {
    eventId: string;
    eventType: string;
    timestamp: string;
    data: Record<string, any>;
}

@Injectable()
export class WebhookService {
    private readonly logger = new Logger(WebhookService.name);

    constructor(
        private readonly prisma: PrismaService,
        @InjectQueue(QueueNames.WEBHOOK) private readonly webhookQueue: Queue,
    ) { }

    /**
     * Dispatches a webhook event to all active webhooks subscribed to the event type.
     */
    async dispatch(protocolId: string, eventType: string, data: Record<string, any>) {
        const webhooks = await this.prisma.webhook.findMany({
            where: {
                protocolId,
                isActive: true,
                events: { has: eventType },
            },
        });

        if (!webhooks.length) return;

        this.logger.debug(`Dispatching '${eventType}' to ${webhooks.length} webhooks for protocol ${protocolId}`);

        const payload: WebhookPayload = {
            eventId: crypto.randomUUID(),
            eventType,
            timestamp: new Date().toISOString(),
            data,
        };

        for (const webhook of webhooks) {
            await this.webhookQueue.add('send-webhook', {
                webhookId: webhook.id,
                url: webhook.url,
                secret: webhook.secretHash, // We stored plaintext in secretHash
                payload,
            }, {
                attempts: 5,
                backoff: { type: 'exponential', delay: 2000 },
            });
        }
    }
}

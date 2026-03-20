import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { QueueNames } from '../queue/queue.constants.js';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class ReceiptService {
    private readonly logger = new Logger(ReceiptService.name);

    constructor(
        private readonly prisma: PrismaService,
        @InjectQueue(QueueNames.RECEIPT_BATCH) private readonly receiptQueue: Queue,
    ) { }

    /**
     * Periodically collect delivered notifications that need ZK receipts
     * and push them to the batch processor queue.
     */
    @Cron(CronExpression.EVERY_MINUTE)
    async enqueueReceiptBatches() {
        this.logger.debug('Scanning for pending ZK receipts...');

        // Find notifications that were delivered but lack a receipt transaction
        const pendingNotifications = await this.prisma.notification.findMany({
            where: {
                writeReceipt: true,
                receiptTx: null,
                status: 'delivered', // Assume 'delivered' is the final success status
            },
            select: {
                id: true,
                protocolId: true,
                walletHash: true,
                category: true,
            },
            take: 20, // Process 20 per minute batch for safety (fits within limits)
        });

        if (pendingNotifications.length === 0) {
            return;
        }

        this.logger.log(`Found ${pendingNotifications.length} pending receipts. Enqueueing batch job...`);

        // Group by protocol if necessary, or just process them as one job
        // Currently pushing a single batch job containing up to 20 notifications
        await this.receiptQueue.add('flush-receipts', {
            notifications: pendingNotifications,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
        });
    }
}

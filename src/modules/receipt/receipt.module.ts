import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from '../queue/queue.constants.js';
import { ReceiptService } from './receipt.service.js';
import { LightClientService } from './light-client.service.js';
import { ReceiptWorker } from './receipt.worker.js';

@Module({
    imports: [
        BullModule.registerQueue({
            name: QueueNames.RECEIPT_BATCH,
        }),
    ],
    providers: [ReceiptService, LightClientService, ReceiptWorker],
    exports: [ReceiptService],
})
export class ReceiptModule { }

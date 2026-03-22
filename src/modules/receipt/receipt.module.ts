import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueNames } from '../queue/queue.constants';
import { ReceiptService } from './receipt.service';
import { LightClientService } from './light-client.service';
import { ReceiptWorker } from './receipt.worker';

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

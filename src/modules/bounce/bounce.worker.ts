import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { QueueNames } from '../queue/queue.constants.js';
import { BounceService } from './bounce.service.js';

@Processor(QueueNames.BOUNCE)
export class BounceWorker extends WorkerHost {
    private readonly logger = new Logger(BounceWorker.name);

    constructor(private readonly bounceService: BounceService) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<void> {
        this.logger.debug(`Processing bounce job ${job.id}`);

        if (job.name === 'ses-bounce') {
            await this.bounceService.processSesBounce(job.data);
        }
    }
}

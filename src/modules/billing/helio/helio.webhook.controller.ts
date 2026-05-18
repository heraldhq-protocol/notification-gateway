import {
  Controller,
  Post,
  Req,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { HelioWebhookGuard } from './helio.webhook.guard';
import type { RequestWithRawBody } from './helio.webhook.guard';
import { HelioEventRepository } from '../repositories/helio-event.repository';
import { ProtocolService } from '../../protocol/protocol.service';
import type { HelioWebhookPayload } from './helio.types';

@Controller('v1/billing/helio')
export class HelioWebhookController {
  constructor(
    private readonly logger: PinoLogger,
    private readonly helioEventRepo: HelioEventRepository,
    private readonly protocolService: ProtocolService,
    @InjectQueue('billing-webhooks') private readonly webhookQueue: Queue,
  ) {}

  @Post('webhook')
  @UseGuards(HelioWebhookGuard)
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RequestWithRawBody,
    @Body() payload: HelioWebhookPayload,
    @Headers('x-helio-signature') _signature: string,
  ): Promise<{ received: boolean }> {
    const rawBodyStr = req.rawBody.toString('utf8');
    const payloadHash = createHash('sha256').update(rawBodyStr).digest('hex');

    // ── Idempotency check ──────────────────────────────────────────
    const existing = await this.helioEventRepo.findByPayloadHash(payloadHash);
    if (existing?.processed) {
      this.logger.info('Duplicate Helio webhook received — skipping', {
        helioEventId: payload.transactionId,
      });
      return { received: true };
    }

    const { protocolPubkey } = payload;
    const protocolId =
      await this.protocolService.findIdByPubkey(protocolPubkey);

    // ── Persist raw event ───────────────────────────
    const eventRecord = await this.helioEventRepo.create({
      helioEventId: payload.transactionId,
      eventType: payload.event,
      protocolId,
      payloadHash,
      processed: false,
    });

    // ── Enqueue for async processing ──────────────────────────────
    await this.webhookQueue.add(
      'process-helio-event',
      {
        eventRecordId: eventRecord.id,
        payload,
      },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    this.logger.info('Helio webhook received and queued', {
      event: payload.event,
      protocolPubkey: protocolPubkey.slice(0, 8) + '...',
    });

    return { received: true };
  }
}

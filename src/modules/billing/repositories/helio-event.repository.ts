import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import {
  HelioWebhookEvent,
  Prisma,
} from '../../../../prisma/generated/prisma/index';

@Injectable()
export class HelioEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByPayloadHash(
    payloadHash: string,
  ): Promise<HelioWebhookEvent | null> {
    return this.prisma.helioWebhookEvent.findFirst({
      where: { payloadHash },
    });
  }

  async create(
    data: Prisma.HelioWebhookEventUncheckedCreateInput,
  ): Promise<HelioWebhookEvent> {
    return this.prisma.helioWebhookEvent.create({ data });
  }

  async markProcessed(helioEventId: string): Promise<void> {
    await this.prisma.helioWebhookEvent.update({
      where: { helioEventId },
      data: {
        processed: true,
        processedAt: new Date(),
      },
    });
  }
}

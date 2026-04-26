import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * OverageMeteringService — tracks per-protocol send counts for quota enforcement.
 *
 * After each successful notification delivery, the MailWorker calls
 * `incrementSendsThisPeriod()` to atomically bump the counter on both
 * the Protocol and Subscription records.
 *
 * This is the missing piece that makes RateLimitService's monthly quota
 * checks actually functional — without this increment, sendsThisPeriod
 * stays at 0 forever.
 */
@Injectable()
export class OverageMeteringService {
  private readonly logger = new Logger(OverageMeteringService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increment the send counter for a protocol.
   * Updates both Protocol.sendsThisPeriod and Subscription.sendsThisPeriod
   * in a single transaction to keep them in sync.
   *
   * @param protocolId - UUID of the protocol
   * @param count - Number of sends to add (default 1)
   */
  async incrementSendsThisPeriod(
    protocolId: string,
    count: number = 1,
  ): Promise<void> {
    try {
      await this.prisma.$transaction([
        // Increment on the Protocol record (used by auth cache)
        this.prisma.protocol.update({
          where: { id: protocolId },
          data: { sendsThisPeriod: { increment: count } },
        }),
        // Also increment on the Subscription record if it exists
        // (used by SubscriptionGuard and BillingService)
        this.prisma.subscription.updateMany({
          where: { protocolId, status: 'active' },
          data: { sendsThisPeriod: { increment: count } },
        }),
      ]);
    } catch (err) {
      // Non-fatal — metering failure should not block delivery
      this.logger.warn(
        `Failed to increment send count for protocol ${protocolId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Reset send counters for a protocol (called at period rollover).
   */
  async resetSendsThisPeriod(protocolId: string): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.protocol.update({
          where: { id: protocolId },
          data: { sendsThisPeriod: 0 },
        }),
        this.prisma.subscription.updateMany({
          where: { protocolId },
          data: { sendsThisPeriod: 0 },
        }),
      ]);
      this.logger.log(`Reset send counters for protocol ${protocolId}`);
    } catch (err) {
      this.logger.error(
        `Failed to reset send count for protocol ${protocolId}: ${(err as Error).message}`,
      );
    }
  }
}

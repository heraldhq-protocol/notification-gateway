import { createHash } from 'crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { SolanaService } from '../../solana/solana.service';
import { NotifyService } from '../notify/notify.service';
import { QueueService } from '../queue/queue.service';
import { PrismaService } from '../../database/prisma.service';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuthenticatedProtocol } from '../../common/types/protocol.types';
import pLimit from 'p-limit';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly solanaService: SolanaService,
    private readonly notifyService: NotifyService,
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Broadcast a system message to ALL registered Herald identities.
   * Fetches all registered wallets from Solana and enqueues notifications.
   */
  async broadcast(dto: BroadcastDto, protocol: AuthenticatedProtocol) {
    this.logger.log(
      `Starting broadcast: ${dto.subject} (Category: ${dto.category})`,
    );

    // 1. Fetch all identities from Solana registry
    const wallets = await this.solanaService.fetchAllIdentities();
    this.logger.log(`Resolved ${wallets.length} identities for broadcast`);

    // 2. Enqueue notifications for each wallet with concurrency limit
    const limit = pLimit(10); // Process 10 notifications concurrently to avoid overwhelming the queue
    const results = await Promise.allSettled(
      wallets.map((wallet) =>
        limit(() =>
          this.notifyService.queueNotification(
            {
              wallet,
              category: dto.category as any,
              subject: dto.subject,
              body: dto.body,
            },
            protocol,
          ),
        ),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;

    this.logger.log(
      `Broadcast enqueued: ${fulfilled} success, ${rejected} failed`,
    );

    return {
      message: 'Broadcast started',
      total_users: wallets.length,
      enqueued_success: fulfilled,
      enqueued_failed: rejected,
    };
  }

  /**
   * Enqueue one BullMQ notification job per wallet in the campaign's audience.
   * Called by POST /internal/campaigns/:id/enqueue (triggered by admin-api after launch).
   */
  async enqueueCampaign(
    campaignId: string,
  ): Promise<{ campaignId: string; enqueued: number }> {
    this.logger.log(`Enqueuing campaign ${campaignId}`);

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { audience: true },
    });

    if (!campaign) {
      throw new NotFoundException({
        error: 'CAMPAIGN_NOT_FOUND',
        message: `Campaign ${campaignId} not found`,
      });
    }

    const wallets: string[] = campaign.audience.wallets;
    const now = new Date();
    const subjectHash = createHash('sha256')
      .update(campaign.subject)
      .digest('hex');

    // Create Notification rows and enqueue jobs with bounded concurrency
    const limit = pLimit(20);
    const results = await Promise.allSettled(
      wallets.map((wallet) =>
        limit(async () => {
          const notificationId = uuidv4();
          const walletHash = createHash('sha256').update(wallet).digest('hex');

          await this.prisma.notification.create({
            data: {
              id: notificationId,
              walletHash,
              subjectHash,
              protocolId: campaign.protocolId,
              status: 'queued',
              category: campaign.category,
              writeReceipt: false,
              queuedAt: now,
            },
          });

          await this.queueService.enqueueNotification({
            notificationId,
            protocolId: campaign.protocolId,
            protocolPubkey: '',
            protocolName: '',
            wallet,
            walletHash,
            subject: campaign.subject,
            body: campaign.body,
            category: campaign.category,
            writeReceipt: false,
            digestMode: false,
            isSandbox: false,
          });
        }),
      ),
    );

    const enqueued = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed > 0) {
      this.logger.warn(
        `Campaign ${campaignId}: ${failed} wallets failed to enqueue`,
      );
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'RUNNING',
        startedAt: now,
        totalTargets: wallets.length,
      },
    });

    this.logger.log(
      `Campaign ${campaignId}: enqueued ${enqueued}/${wallets.length}`,
    );
    return { campaignId, enqueued };
  }
}

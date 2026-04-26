import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { QueueNames } from '../queue.constants';
import { RoutingService } from '../../routing/routing.service';
import { ChannelDispatchService } from '../../channel/channel-dispatch.service';
import { PrismaService } from '../../../database/prisma.service';
import { DigestService } from '../../notify/digest.service';

interface DigestEntry {
  id: string;
  protocolId: string;
  subject: string;
  category: string;
  queuedAt: string; // ISO string from BullMQ serialization
}

interface DigestJobData {
  walletHash: string;
  entries: DigestEntry[];
}

/**
 * DigestWorker — processes digest flush jobs.
 *
 * Receives a batch of buffered notifications for a single wallet,
 * builds a consolidated digest email, and delivers it.
 *
 * The digest is rendered as a single email containing all buffered
 * notifications grouped by protocol and category.
 */
@Processor(QueueNames.DIGEST, {
  lockDuration: 120000, // 2 minutes for digest rendering + delivery
  stalledInterval: 60000,
  maxStalledCount: 1,
})
@Injectable()
export class DigestWorker extends WorkerHost {
  private readonly logger = new Logger(DigestWorker.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly channelDispatch: ChannelDispatchService,
    private readonly prisma: PrismaService,
    private readonly digestService: DigestService,
  ) {
    super();
  }

  async process(job: Job<DigestJobData>): Promise<void> {
    const { walletHash, entries } = job.data;

    if (!entries || entries.length === 0) return;

    this.logger.log(
      `Processing digest flush for wallet ${walletHash.slice(0, 8)}... (${entries.length} entries)`,
    );

    try {
      // Look up the wallet pubkey from the notification records
      // We need a notification that has this walletHash to find the original wallet
      const notification = await this.prisma.notification.findFirst({
        where: { walletHash },
        select: { id: true },
        orderBy: { queuedAt: 'desc' },
      });

      if (!notification) {
        this.logger.warn(
          `No notification found for wallet hash ${walletHash.slice(0, 8)}... — cannot resolve identity for digest`,
        );
        // Mark as sent to prevent re-processing
        await this.digestService.markAsSent(entries.map((e) => e.id));
        return;
      }

      // Build the consolidated digest body
      const digestBody = this.buildDigestBody(entries);

      // Get protocol info for the first entry (used for from address)
      const protocol = await this.prisma.protocol.findUnique({
        where: { id: entries[0].protocolId },
      });

      // Build a synthetic notification job for the channel dispatcher
      const syntheticJob = {
        notificationId: `digest-${walletHash.slice(0, 8)}-${Date.now()}`,
        protocolId: entries[0].protocolId,
        protocolPubkey: protocol?.protocolPubkey ?? '',
        protocolName: 'Herald Digest',
        wallet: '', // Not used for digest — we resolve channels differently
        subject: `Your notification digest (${entries.length} updates)`,
        body: digestBody,
        category: 'system',
        writeReceipt: false,
        digestMode: false, // Don't re-digest!
        priority: 'normal' as const,
        tier: protocol?.tier ?? 0,
      };

      // For digest, we need to find the wallet pubkey to resolve channels.
      // Since we only have the hash, we look up the portal user's registered channels.
      const portalUser = await this.prisma.portal_users.findUnique({
        where: { wallet_hash: walletHash },
      });

      if (!portalUser) {
        this.logger.warn(
          `Portal user not found for digest wallet ${walletHash.slice(0, 8)}...`,
        );
        await this.digestService.markAsSent(entries.map((e) => e.id));
        return;
      }

      // Dispatch via email only for digest (primary digest channel)
      // The channel dispatch will handle template rendering
      const result = await this.channelDispatch.dispatch(
        {
          email: undefined, // Will be resolved via routing service if possible
          telegramChatId: undefined,
          phone: undefined,
        },
        syntheticJob,
      );

      if (result.successCount > 0) {
        this.logger.log(
          `Digest delivered for wallet ${walletHash.slice(0, 8)}... (${entries.length} entries)`,
        );
      } else {
        this.logger.warn(
          `Digest delivery failed for wallet ${walletHash.slice(0, 8)}...`,
        );
      }

      // Mark all entries as sent regardless of delivery outcome
      // (we don't want to re-send on next flush)
      await this.digestService.markAsSent(entries.map((e) => e.id));
    } catch (err) {
      this.logger.error(
        `Digest flush failed for wallet ${walletHash.slice(0, 8)}...: ${(err as Error).message}`,
      );
      throw err; // Let BullMQ retry
    }
  }

  /**
   * Build a consolidated digest body from multiple notifications.
   */
  private buildDigestBody(entries: DigestEntry[]): string {
    const lines: string[] = [
      `Here's a summary of your ${entries.length} notification${entries.length > 1 ? 's' : ''} since your last digest:\n`,
    ];

    // Group by category
    const byCategory = new Map<string, DigestEntry[]>();
    for (const entry of entries) {
      const cat = entry.category || 'general';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(entry);
    }

    for (const [category, catEntries] of byCategory) {
      const emoji: Record<string, string> = {
        defi: '💰',
        governance: '🗳️',
        system: '⚙️',
        marketing: '📢',
      };
      const icon = emoji[category] ?? '🔔';
      lines.push(
        `${icon} **${category.charAt(0).toUpperCase() + category.slice(1)}** (${catEntries.length})`,
      );

      for (const entry of catEntries) {
        const time = new Date(entry.queuedAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        });
        lines.push(`  • ${entry.subject} _(${time})_`);
      }
      lines.push('');
    }

    lines.push(
      '---',
      'You can adjust your digest preferences at [app.useherald.xyz](https://app.useherald.xyz)',
    );

    return lines.join('\n');
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { SolanaService } from '../../solana/solana.service';
import { NotifyService } from '../notify/notify.service';
import { BroadcastDto } from './dto/broadcast.dto';
import { AuthenticatedProtocol } from '../../common/types/protocol.types';
import pLimit from 'p-limit';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly solanaService: SolanaService,
    private readonly notifyService: NotifyService,
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
}

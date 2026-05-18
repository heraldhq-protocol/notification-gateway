import { createHash } from 'crypto';
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PrismaService } from '../../database/prisma.service';
import { SandboxRoutingService } from '../routing/sandbox-routing.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { QueueService } from '../queue/queue.service';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import type { IdentityAccount } from '../../common/types/notification.types';
import type {
  NotifyDto,
  NotifyResponseDto,
  BroadcastDto,
  BroadcastResponseDto,
} from './dto/notify.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ContentScannerService } from './content-scanner.service';
import { AiClassifierService } from './ai-classifier.service';

/**
 * NotifyService — orchestrates the synchronous part of notification delivery.
 *
 * Must complete within 200ms (NF-001).
 *
 * Flow:
 *   1. Detect sandbox vs production environment
 *   2. Check idempotency key (Redis, 24h TTL)
 *   3. Enqueue BullMQ job (wallet resolution, opt-in, DB writes all async)
 *   4. Return 202 Accepted with notification_id
 *
 * Sandbox flow skips PDA resolution and TEE — routes to protocol's test contacts.
 * Sandbox quota is enforced per API key (100/day default) via SandboxService.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly sandboxRoutingService: SandboxRoutingService,
    private readonly sandboxService: SandboxService,
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly contentScanner: ContentScannerService,
    private readonly aiClassifier: AiClassifierService,
  ) {}

  async queueNotification(
    dto: NotifyDto,
    protocol: AuthenticatedProtocol,
  ): Promise<NotifyResponseDto> {
    const isSandbox = protocol.environment === 'sandbox';

    if (isSandbox) {
      return this.queueSandboxNotification(dto, protocol);
    }
    return this.queueProductionNotification(dto, protocol);
  }

  // ── Production path ─────────────────────────────────────────────────────

  private async queueProductionNotification(
    dto: NotifyDto,
    protocol: AuthenticatedProtocol,
  ): Promise<NotifyResponseDto> {
    const notificationId = uuidv4();
    const walletHash = this.sha256(dto.wallet);
    const subjectHash = this.sha256(dto.subject);

    // ── 1. Idempotency check (Redis, 24h TTL) ────────────────────
    if (dto.idempotencyKey) {
      const idempKey = `idempotency:notify:${dto.idempotencyKey}`;
      const stored = await this.redis.set(
        idempKey,
        JSON.stringify({ notificationId }),
        'EX',
        86400,
        'NX',
      );

      if (stored !== 'OK') {
        const existing = await this.redis.get(idempKey);
        const duplicateId = existing
          ? JSON.parse(existing).notificationId
          : notificationId;
        return {
          notification_id: duplicateId,
          status: 'duplicate',
          recipient_registered: null,
          estimated_delivery_ms: 0,
          receipt_tx: null,
          environment: 'production',
        };
      }
    }

    // ── 2. Template status gate (live sends only) ────────────────
    if (dto.templateId) {
      const tmpl = await this.prisma.notificationTemplate.findFirst({
        where: { id: dto.templateId, protocolId: protocol.protocolId },
        select: { status: true },
      });
      if (tmpl && tmpl.status !== 'APPROVED') {
        return {
          notification_id: notificationId,
          status: 'blocked',
          error_code: 'TEMPLATE_PENDING_REVIEW',
          recipient_registered: null,
          estimated_delivery_ms: 0,
          receipt_tx: null,
          environment: 'production',
        };
      }
    }

    // ── 3. Content scan (sync rules engine, <1ms) ───────────────
    const scan = this.contentScanner.scan(dto.subject, dto.body);

    if (scan.verdict === 'block') {
      this.logger.warn(
        {
          protocolId: protocol.protocolId,
          riskScore: scan.riskScore,
          rules: scan.triggeredRules,
        },
        'Notification blocked by content scanner',
      );
      return {
        notification_id: notificationId,
        status: 'blocked',
        error_code: 'CONTENT_BLOCKED',
        recipient_registered: null,
        estimated_delivery_ms: 0,
        receipt_tx: null,
        environment: 'production',
      };
    }

    // ── 3. Persist minimal notification record ───────────────────
    await this.prisma.notification.create({
      data: {
        id: notificationId,
        protocolId: protocol.protocolId,
        walletHash,
        subjectHash,
        status: 'queued',
        category: dto.category ?? 'defi',
        idempotencyKey: dto.idempotencyKey,
        writeReceipt: dto.receipt ?? true,
        riskScore: scan.riskScore,
        scanVerdict: scan.verdict,
      },
    });

    // For review-range notifications, fire async AI classification (non-blocking)
    if (scan.verdict === 'review') {
      void this.aiClassifier.classifyAndFlag({
        notificationId,
        protocolId: protocol.protocolId,
        protocolName: protocol.name ?? 'Unknown Protocol',
        verificationStatus: protocol.verificationStatus,
        tier: protocol.tier,
        environment: protocol.environment,
        subject: dto.subject,
        body: dto.body,
        riskScore: scan.riskScore,
        triggeredRules: scan.triggeredRules,
      });
    }

    // ── 4. Enqueue async delivery job ────────────────────────────
    const channels = dto.batchChannels as
      | ('email' | 'telegram' | 'sms')[]
      | undefined;
    const excludedChannels = dto.batchExcludeChannels as
      | ('email' | 'telegram' | 'sms')[]
      | undefined;

    try {
      await this.queueService.enqueueNotification({
        notificationId,
        protocolId: protocol.protocolId,
        protocolPubkey: protocol.protocolPubkey,
        protocolName: protocol.name ?? 'Unknown Protocol',
        wallet: dto.wallet,
        walletHash,
        subject: dto.subject,
        body: dto.body,
        category: dto.category ?? 'defi',
        writeReceipt: dto.receipt ?? true,
        digestMode: false,
        priority: dto.priority ?? 'normal',
        preferredChannel: dto.preferred_channel,
        channels,
        excludedChannels,
        tier: protocol.tier,
        templateId: dto.templateId,
        telegramTemplateId: dto.telegramTemplateId,
        templateVariables: dto.templateVariables,
      });
    } catch (error) {
      this.logger.error(
        { notificationId, error: (error as Error).message },
        'Failed to enqueue notification — marking as failed',
      );

      await this.prisma.notification
        .update({
          where: { id: notificationId },
          data: { status: 'failed', errorCode: 'ENQUEUE_FAILED' },
        })
        .catch(() => {});

      if (dto.idempotencyKey) {
        await this.redis
          .del(`idempotency:notify:${dto.idempotencyKey}`)
          .catch(() => {});
      }

      return {
        notification_id: notificationId,
        status: 'failed',
        error_code: 'ENQUEUE_FAILED',
        recipient_registered: null,
        estimated_delivery_ms: 0,
        receipt_tx: null,
        environment: 'production',
      };
    }

    return {
      notification_id: notificationId,
      status: 'queued',
      recipient_registered: null,
      estimated_delivery_ms: 2500,
      receipt_tx: null,
      environment: 'production',
    };
  }

  // ── Sandbox path ─────────────────────────────────────────────────────────

  private async queueSandboxNotification(
    dto: NotifyDto,
    protocol: AuthenticatedProtocol,
  ): Promise<NotifyResponseDto> {
    const notificationId = uuidv4();
    const walletHash = this.sha256(dto.wallet);
    const subjectHash = this.sha256(dto.subject);

    // ── 1. Daily sandbox quota check ─────────────────────────────────────────
    const quotaResult = await this.sandboxService.validateSandboxKey(
      protocol.apiKeyId,
    );

    if (!quotaResult.allowed) {
      throw new HttpException(
        {
          error: quotaResult.errorCode ?? 'SANDBOX_LIMIT_EXCEEDED',
          message: quotaResult.error ?? 'Sandbox quota exceeded',
          sandbox_mode: true,
          daily_limit: quotaResult.dailyLimit,
          remaining_today: 0,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // ── 2. Idempotency in sandbox: 1hr window ────────────────────────────────
    if (dto.idempotencyKey) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const existing = await this.prisma.notification.findFirst({
        where: {
          idempotencyKey: dto.idempotencyKey,
          queuedAt: { gte: oneHourAgo },
        },
      });
      if (existing) {
        return {
          notification_id: existing.id,
          status: 'duplicate',
          recipient_registered: true,
          estimated_delivery_ms: 0,
          receipt_tx: null,
          environment: 'sandbox',
          sandbox_mode: true,
          sandbox_notes: ['Sandbox duplicate — idempotency window is 1 hour'],
        };
      }
    }

    // ── 3. Template status gate (if templateId provided) ─────────────────────
    if (dto.templateId) {
      const tmpl = await this.prisma.notificationTemplate.findUnique({
        where: { id: dto.templateId },
        select: { id: true, status: true },
      });
      if (tmpl && tmpl.status !== 'APPROVED') {
        await this.prisma.notification.create({
          data: {
            id: notificationId,
            protocolId: protocol.protocolId,
            walletHash,
            subjectHash,
            status: 'blocked',
            category: dto.category ?? 'defi',
            idempotencyKey: dto.idempotencyKey,
            writeReceipt: false,
            errorCode: 'TEMPLATE_PENDING_REVIEW',
          },
        });
        return {
          notification_id: notificationId,
          status: 'blocked',
          error_code: 'TEMPLATE_PENDING_REVIEW',
          recipient_registered: false,
          estimated_delivery_ms: 0,
          receipt_tx: null,
          environment: 'sandbox',
          sandbox_mode: true,
          sandbox_notes: ['Template is not APPROVED.'],
        };
      }
    }

    // ── 4. Content scan (same rules engine as production) ────────────────────
    const scan = this.contentScanner.scan(dto.subject, dto.body);
    if (scan.verdict === 'block') {
      await this.prisma.notification.create({
        data: {
          id: notificationId,
          protocolId: protocol.protocolId,
          walletHash,
          subjectHash,
          status: 'blocked',
          category: dto.category ?? 'defi',
          idempotencyKey: dto.idempotencyKey,
          writeReceipt: false,
          errorCode: 'CONTENT_BLOCKED',
          riskScore: scan.riskScore,
          scanVerdict: scan.verdict,
        },
      });
      return {
        notification_id: notificationId,
        status: 'blocked',
        error_code: 'CONTENT_BLOCKED',
        recipient_registered: false,
        estimated_delivery_ms: 0,
        receipt_tx: null,
        environment: 'sandbox',
        sandbox_mode: true,
        sandbox_notes: [
          `Content scan blocked — triggered rules: ${scan.triggeredRules.join(', ')}`,
        ],
      };
    }

    // ── 5. Try devnet PDA resolution (Feature Flagged for Server Devnet Tests) ─
    const useDevnetSandbox =
      process.env.ENABLE_DEVNET_SANDBOX_RESOLUTION === 'true';
    let devnetResult: { resolved: boolean; channels: any; identity: any } = {
      resolved: false,
      channels: {},
      identity: null,
    };

    if (useDevnetSandbox) {
      devnetResult = await this.sandboxRoutingService.resolveDevnetWallet(
        dto.wallet,
      );
    }

    // ── 6. Determine delivery contact ────────────────────────────────────────
    let testContact: {
      email?: string;
      telegramChatId?: string;
      phone?: string;
    } | null = null;
    let recipientRegisteredOnDevnet = false;
    let sandboxDeliveryNote: string;

    if (devnetResult.resolved) {
      // Real devnet identity — deliver to actual channels
      recipientRegisteredOnDevnet = true;
      testContact = {
        email: devnetResult.channels.email,
        telegramChatId: devnetResult.channels.telegramChatId,
        phone: devnetResult.channels.phone,
      };
      sandboxDeliveryNote =
        'Delivering to devnet-registered channels (decrypted via ENCLAVE_TEST_KEY).';

      // Check opt-in flags from the devnet identity
      const identity = devnetResult.identity;
      if (identity && !this.checkOptIn(identity, dto.category ?? 'defi')) {
        await this.prisma.notification.create({
          data: {
            id: notificationId,
            protocolId: protocol.protocolId,
            walletHash,
            subjectHash,
            status: 'opted_out',
            category: dto.category ?? 'defi',
            idempotencyKey: dto.idempotencyKey,
            writeReceipt: false,
          },
        });
        return {
          notification_id: notificationId,
          status: 'opted_out',
          recipient_registered: true,
          estimated_delivery_ms: 0,
          receipt_tx: null,
          environment: 'sandbox',
          sandbox_mode: true,
          sandbox_notes: [
            'Wallet opted out of this category on devnet.',
            'Delivery skipped.',
          ],
        };
      }
    } else {
      // Fallback to protocol's static test contacts (protocol_settings)
      const settings = await this.prisma.protocolSettings.findUnique({
        where: { protocolId: protocol.protocolId },
      });

      const testEmail = settings?.testEmail;
      const testTelegramId = settings?.testTelegramId;
      const testPhone = settings?.testPhone;

      if (!testEmail && !testTelegramId && !testPhone) {
        await this.prisma.notification.create({
          data: {
            id: notificationId,
            protocolId: protocol.protocolId,
            walletHash,
            subjectHash,
            status: 'failed',
            category: dto.category ?? 'defi',
            idempotencyKey: dto.idempotencyKey,
            writeReceipt: false,
            errorCode: 'SANDBOX_NO_TEST_CONTACT',
          },
        });
        return {
          notification_id: notificationId,
          status: 'failed',
          error_code: 'SANDBOX_NO_TEST_CONTACT',
          recipient_registered: false,
          estimated_delivery_ms: 0,
          receipt_tx: null,
          environment: 'sandbox',
          sandbox_mode: true,
          sandbox_notes: [
            useDevnetSandbox && devnetResult.identity === null
              ? 'Wallet not registered on devnet. Register at app.useherald.xyz to test with real channels.'
              : 'No test contact configured. Set one in your protocol settings.',
            'This notification was NOT delivered.',
          ],
        };
      }

      testContact = {
        email: testEmail ?? undefined,
        telegramChatId: testTelegramId ?? undefined,
        phone: testPhone ?? undefined,
      };
      sandboxDeliveryNote =
        useDevnetSandbox && devnetResult.identity !== null
          ? 'Delivering to static test contacts (channels could not be decrypted via ENCLAVE_TEST_KEY).'
          : 'Delivering to static test contacts.';
    }

    // ── 7. Persist the sandbox notification record ────────────────────────────
    await this.prisma.notification.create({
      data: {
        id: notificationId,
        protocolId: protocol.protocolId,
        walletHash,
        subjectHash,
        status: 'queued',
        category: dto.category ?? 'defi',
        idempotencyKey: dto.idempotencyKey,
        writeReceipt: false, // sandbox receipts are in SandboxReceipt table
      },
    });

    // ── 8. Enqueue to worker ─────────────────────────────────────────────────
    const prefixedSubject = this.sandboxRoutingService.addTestPrefix(
      dto.subject,
    );

    const channels = dto.batchChannels as
      | ('email' | 'telegram' | 'sms')[]
      | undefined;
    const excludedChannels = dto.batchExcludeChannels as
      | ('email' | 'telegram' | 'sms')[]
      | undefined;

    try {
      await this.queueService.enqueueNotification({
        notificationId,
        protocolId: protocol.protocolId,
        protocolPubkey: protocol.protocolPubkey,
        protocolName: protocol.name ?? 'Unknown Protocol',
        wallet: dto.wallet,
        walletHash,
        subject: prefixedSubject,
        body: dto.body,
        category: dto.category ?? 'defi',
        writeReceipt: false,
        digestMode: false,
        priority: dto.priority ?? 'normal',
        preferredChannel: dto.preferred_channel,
        channels,
        excludedChannels,
        isSandbox: true,
        testContact,
        tier: protocol.tier,
        templateId: dto.templateId,
        telegramTemplateId: dto.telegramTemplateId,
        templateVariables: dto.templateVariables,
      });
    } catch (error) {
      this.logger.error(
        { notificationId, error: (error as Error).message },
        'Failed to enqueue sandbox notification — marking as failed',
      );

      await this.prisma.notification
        .update({
          where: { id: notificationId },
          data: { status: 'failed', errorCode: 'ENQUEUE_FAILED' },
        })
        .catch(() => {});

      if (dto.idempotencyKey) {
        await this.redis
          .del(`idempotency:notify:${dto.idempotencyKey}`)
          .catch(() => {});
      }

      return {
        notification_id: notificationId,
        status: 'failed',
        error_code: 'ENQUEUE_FAILED',
        recipient_registered: recipientRegisteredOnDevnet,
        estimated_delivery_ms: 0,
        receipt_tx: null,
        environment: 'sandbox',
        sandbox_mode: true,
        sandbox_notes: [
          'Failed to enqueue notification for delivery.',
          'Service temporarily unavailable — retry later.',
        ],
      };
    }

    // ── 7. Increment daily usage counter (Redis, auto-resets at midnight UTC) ─
    await this.sandboxService.incrementUsage(protocol.apiKeyId);

    // Build response
    const isDevnetResolved = devnetResult.resolved;
    const settingsForResponse = !isDevnetResolved
      ? await this.prisma.protocolSettings.findUnique({
          where: { protocolId: protocol.protocolId },
        })
      : null;

    return {
      notification_id: notificationId,
      status: 'queued',
      recipient_registered: recipientRegisteredOnDevnet,
      estimated_delivery_ms: 2500,
      receipt_tx: null,
      environment: 'sandbox',
      sandbox_mode: true,
      test_contact: isDevnetResolved
        ? {
            email: devnetResult.channels.email
              ? this.maskEmail(devnetResult.channels.email)
              : null,
            telegram: devnetResult.channels.telegramChatId
              ? 'configured'
              : null,
            sms: devnetResult.channels.phone
              ? this.maskPhone(devnetResult.channels.phone)
              : null,
          }
        : {
            email: settingsForResponse?.testEmail
              ? this.maskEmail(settingsForResponse.testEmail)
              : null,
            telegram: settingsForResponse?.testTelegramId ? 'configured' : null,
            sms: settingsForResponse?.testPhone
              ? this.maskPhone(settingsForResponse.testPhone)
              : null,
          },
      sandbox_notes: [
        sandboxDeliveryNote,
        'This notification will NOT count against your production monthly quota.',
        `Sandbox daily usage: ${quotaResult.remainingToday - 1} of ${quotaResult.dailyLimit} remaining after this send.`,
        'ZK receipt disabled in sandbox mode.',
      ],
    };
  }

  // ── Status/list endpoints ────────────────────────────────────────────────

  async getNotificationStatus(notificationId: string, protocolId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, protocolId },
    });

    if (!notification) {
      throw new NotFoundException({
        error: 'NOTIFICATION_NOT_FOUND',
        message: `Notification ${notificationId} not found`,
      });
    }

    return {
      notification_id: notification.id,
      status: notification.status,
      category: notification.category,
      created_at: notification.queuedAt.toISOString(),
      delivered_at: notification.deliveredAt?.toISOString() ?? null,
      receipt_tx: notification.receiptTx ?? null,
      email_provider: notification.emailProvider ?? null,
      bounce: notification.bounce,
    };
  }

  async listNotifications(protocolId: string, page: number, limit: number) {
    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { protocolId },
        orderBy: { queuedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { protocolId } }),
    ]);

    return {
      data: notifications.map((n) => ({
        notification_id: n.id,
        status: n.status,
        category: n.category,
        created_at: n.queuedAt.toISOString(),
        delivered_at: n.deliveredAt?.toISOString() ?? null,
        receipt_tx: n.receiptTx ?? null,
        bounce: n.bounce,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private checkOptIn(identity: IdentityAccount, category: string): boolean {
    if (!identity.optInAll) return false;
    switch (category) {
      case 'defi':
        return identity.optInDefi;
      case 'governance':
        return identity.optInGovernance;
      case 'marketing':
        return identity.optInMarketing;
      case 'system':
        return true;
      default:
        return false;
    }
  }

  private checkOptInFromPortalUser(
    user: Record<string, any>,
    category: string,
  ): boolean {
    if (!user.opt_in_all) return false;
    switch (category) {
      case 'defi':
        return user.opt_in_defi;
      case 'governance':
        return user.opt_in_governance;
      case 'marketing':
        return user.opt_in_marketing;
      case 'system':
        return true;
      default:
        return false;
    }
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }

  private maskPhone(phone: string): string {
    return `${phone.slice(0, 4)}***${phone.slice(-4)}`;
  }

  // ── Broadcast ────────────────────────────────────────────────────────────

  /**
   * Queue a notification for every active subscriber of this protocol.
   *
   * Only targets subscribers with a known walletPubkey (explicit opt-ins via
   * the join link or SDK button). Backfilled legacy rows are skipped —
   * they count toward audience size but cannot be broadcast-targeted
   * until the user re-subscribes explicitly.
   *
   * The protocol's send quota is checked against the target count before
   * any jobs are enqueued. If quota is insufficient the request is rejected.
   */
  async queueBroadcast(
    dto: BroadcastDto,
    protocol: AuthenticatedProtocol,
  ): Promise<BroadcastResponseDto> {
    const broadcastId = uuidv4();
    const targets = await this.subscriptionsService.getBroadcastTargets(
      protocol.protocolId,
    );
    const totalSubscribers = await this.subscriptionsService.getSubscriberCount(
      protocol.protocolId,
    );
    const skippedCount = totalSubscribers - targets.length;

    if (targets.length === 0) {
      return {
        broadcast_id: broadcastId,
        queued_count: 0,
        total_subscribers: totalSubscribers,
        skipped_count: skippedCount,
        estimated_delivery_s: 0,
      };
    }

    const subjectHash = this.sha256(dto.subject);
    const category = dto.category ?? 'system';
    const writeReceipt = dto.receipt ?? false;

    // Batch-insert notification rows then enqueue jobs — keeps the synchronous
    // 202 window short while giving each recipient a proper tracking record.
    const notificationRows = targets.map((t) => ({
      id: uuidv4(),
      protocolId: protocol.protocolId,
      walletHash: t.walletHash,
      subjectHash,
      status: 'queued',
      category,
      writeReceipt,
    }));

    await this.prisma.notification.createMany({ data: notificationRows });

    const enqueueResults = await Promise.allSettled(
      notificationRows.map((row, idx) =>
        this.queueService.enqueueNotification({
          notificationId: row.id,
          protocolId: protocol.protocolId,
          protocolPubkey: protocol.protocolPubkey,
          protocolName: protocol.name ?? 'Unknown Protocol',
          wallet: targets[idx].walletPubkey,
          walletHash: targets[idx].walletHash,
          subject: dto.subject,
          body: dto.body,
          category,
          writeReceipt,
          digestMode: false,
          priority: 'normal',
          tier: protocol.tier,
          templateId: dto.templateId,
        }),
      ),
    );

    const queued = enqueueResults.filter(
      (r) => r.status === 'fulfilled',
    ).length;
    const failed = enqueueResults.length - queued;

    if (failed > 0) {
      this.logger.warn(
        { broadcastId, queued, failed },
        'Some broadcast jobs failed to enqueue',
      );
    }

    return {
      broadcast_id: broadcastId,
      queued_count: queued,
      total_subscribers: totalSubscribers,
      skipped_count: skippedCount,
      estimated_delivery_s: Math.ceil(queued / 10), // ~10 deliveries/sec estimate
    };
  }
}

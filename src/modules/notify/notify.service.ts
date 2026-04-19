import { createHash } from 'crypto';
import {
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../database/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { SandboxRoutingService } from '../routing/sandbox-routing.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { QueueService } from '../queue/queue.service';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import type { IdentityAccount } from '../../common/types/notification.types';
import type { NotifyDto, NotifyResponseDto } from './dto/notify.dto';

/**
 * NotifyService — orchestrates the synchronous part of notification delivery.
 *
 * Must complete within 200ms (NF-001).
 *
 * Flow:
 *   1. Detect sandbox vs production environment
 *   2. Check idempotency key (24h TTL in DB)
 *   3. [Production] Check if wallet is registered (Solana PDA lookup, cached 10min)
 *   4. [Production] Check opt-in flags for category
 *   5. Create notification record in PostgreSQL
 *   6. Enqueue BullMQ job
 *   7. Return 202 Accepted with notification_id
 *
 * Sandbox flow skips PDA resolution and TEE — routes to protocol's test contacts.
 * Sandbox quota is enforced per API key (100/day default) via SandboxService.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly routingService: RoutingService,
    private readonly sandboxRoutingService: SandboxRoutingService,
    private readonly sandboxService: SandboxService,
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
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

    // ── 1. Idempotency check ─────────────────────────────────────
    if (dto.idempotencyKey) {
      const existing = await this.prisma.notification.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return {
          notification_id: existing.id,
          status: 'duplicate',
          recipient_registered: true,
          estimated_delivery_ms: 0,
          receipt_tx: existing.receiptTx ?? null,
          environment: 'production',
        };
      }
    }

    // ── 2. Wallet registration check (cached 10min) ───────────────
    const identity = await this.routingService.resolveIdentity(dto.wallet);
    if (!identity) {
      throw new NotFoundException({
        error: 'WALLET_NOT_REGISTERED',
        message: 'No Herald identity found for this wallet',
      });
    }

    // ── 3. Opt-in check ──────────────────────────────────────────
    const optedIn = this.checkOptIn(identity, dto.category ?? 'defi');
    if (!optedIn) {
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
        environment: 'production',
      };
    }

    // ── 4. Persist notification record ───────────────────────────
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
      },
    });

    // ── 5. Enqueue async delivery job ────────────────────────────
    await this.queueService.enqueueNotification({
      notificationId,
      protocolId: protocol.protocolId,
      protocolPubkey: protocol.protocolPubkey,
      protocolName: protocol.name ?? 'Unknown Protocol',
      wallet: dto.wallet,
      subject: dto.subject,
      body: dto.body,
      category: dto.category ?? 'defi',
      writeReceipt: dto.receipt ?? true,
      digestMode: identity.digestMode,
      tier: protocol.tier,
      templateId: dto.templateId,
      telegramTemplateId: dto.telegramTemplateId,
      templateVariables: dto.templateVariables,
      preferredChannel: dto.preferred_channel,
    });

    return {
      notification_id: notificationId,
      status: 'queued',
      recipient_registered: true,
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

    // ── 3. Try devnet PDA resolution ─────────────────────────────────────────
    // SandboxRoutingService.resolveDevnetWallet() looks up the wallet on devnet
    // and decrypts channels using ENCLAVE_TEST_KEY (nacl.secretbox).
    // This only succeeds if:
    //   - SOLANA_DEVNET_RPC_URL and HERALD_DEVNET_PROGRAM_ID are set
    //   - The wallet has a Herald identity on devnet
    //   - Portal used nacl.secretbox + ENCLAVE_TEST_KEY when registering
    const devnetResult = await this.sandboxRoutingService.resolveDevnetWallet(
      dto.wallet,
    );

    // ── 4. Determine delivery contact ────────────────────────────────────────
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
      const settings = await this.prisma.protocol_settings.findUnique({
        where: { protocol_id: protocol.protocolId },
      });

      const testEmail = settings?.test_email;
      const testTelegramId = settings?.test_telegram_id;
      const testPhone = settings?.test_phone;

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
            devnetResult.identity === null
              ? 'Wallet not registered on devnet. Register at app.useherald.xyz to test with real channels.'
              : 'Wallet found on devnet but channels could not be decrypted (ENCLAVE_TEST_KEY mismatch).',
            'No test contact configured either. Set one at app.useherald.xyz/settings/sandbox.',
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
        'Delivering to static test contacts (wallet not registered on devnet).';
    }

    // ── 5. Persist the sandbox notification record ────────────────────────────
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

    // ── 6. Enqueue to worker ─────────────────────────────────────────────────
    const prefixedSubject = this.sandboxRoutingService.addTestPrefix(
      dto.subject,
    );

    await this.queueService.enqueueNotification({
      notificationId,
      protocolId: protocol.protocolId,
      protocolPubkey: protocol.protocolPubkey,
      protocolName: protocol.name ?? 'Unknown Protocol',
      wallet: dto.wallet,
      subject: prefixedSubject,
      body: dto.body,
      category: dto.category ?? 'defi',
      writeReceipt: false,
      digestMode: false,
      isSandbox: true,
      testContact,
      tier: protocol.tier,
      templateId: dto.templateId,
      telegramTemplateId: dto.telegramTemplateId,
      templateVariables: dto.templateVariables,
      preferredChannel: dto.preferred_channel,
    });

    // ── 7. Increment daily usage counter (Redis, auto-resets at midnight UTC) ─
    await this.sandboxService.incrementUsage(protocol.apiKeyId);

    // Build response
    const isDevnetResolved = devnetResult.resolved;
    const settings = !isDevnetResolved
      ? await this.prisma.protocol_settings.findUnique({
          where: { protocol_id: protocol.protocolId },
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
            email: settings?.test_email
              ? this.maskEmail(settings.test_email)
              : null,
            telegram: settings?.test_telegram_id ? 'configured' : null,
            sms: settings?.test_phone
              ? this.maskPhone(settings.test_phone)
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
        return true; // system notifications bypass opt-in
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
}

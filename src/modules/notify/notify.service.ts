import { createHash } from 'crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../database/prisma.service';
import { RoutingService } from '../routing/routing.service';
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
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly routingService: RoutingService,
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

    // Idempotency in sandbox: 1hr window (devs iterate faster)
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
          sandbox_notes: ['Sandbox duplicate — idempotency window is 1 hour'],
        };
      }
    }

    // Fetch protocol's test contacts from settings
    const settings = await this.prisma.protocol_settings.findUnique({
      where: { protocol_id: protocol.protocolId },
    });

    const testEmail = (settings as any)?.test_email as string | undefined;
    const testTelegramId = (settings as any)?.test_telegram_id as
      | string
      | undefined;
    const testPhone = (settings as any)?.test_phone as string | undefined;

    if (!testEmail && !testTelegramId && !testPhone) {
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
          errorCode: 'SANDBOX_NO_TEST_CONTACT',
        },
      });

      return {
        notification_id: notificationId,
        status: 'queued',
        recipient_registered: true,
        estimated_delivery_ms: 0,
        receipt_tx: null,
        environment: 'sandbox',
        sandbox_notes: [
          'No test contact configured. Set a test email at app.useherald.xyz/settings/sandbox.',
          'This notification was NOT delivered.',
        ],
      };
    }

    // Persist the sandbox notification record
    await this.prisma.notification.create({
      data: {
        id: notificationId,
        protocolId: protocol.protocolId,
        walletHash,
        subjectHash,
        status: 'queued',
        category: dto.category ?? 'defi',
        idempotencyKey: dto.idempotencyKey,
        writeReceipt: false, // Sandbox receipts always off by default
      },
    });

    // Enqueue with sandbox flag — worker skips PDA lookup + TEE decryption
    await this.queueService.enqueueNotification({
      notificationId,
      protocolId: protocol.protocolId,
      protocolPubkey: protocol.protocolPubkey,
      protocolName: protocol.name ?? 'Unknown Protocol',
      wallet: dto.wallet,
      subject: `[HERALD TEST] ${dto.subject}`,
      body: dto.body,
      category: dto.category ?? 'defi',
      writeReceipt: false,
      digestMode: false,
      isSandbox: true,
      testContact: {
        email: testEmail,
        telegramChatId: testTelegramId,
        phone: testPhone,
      },
      tier: protocol.tier,
      templateId: dto.templateId,
      telegramTemplateId: dto.telegramTemplateId,
      templateVariables: dto.templateVariables,
    });

    return {
      notification_id: notificationId,
      status: 'queued',
      recipient_registered: true,
      estimated_delivery_ms: 2500,
      receipt_tx: null,
      environment: 'sandbox',
      test_contact: {
        email: testEmail ? this.maskEmail(testEmail) : null,
        telegram: testTelegramId ? 'configured' : null,
        sms: testPhone ? this.maskPhone(testPhone) : null,
      },
      sandbox_notes: [
        'Delivery goes to your configured test contact, not the wallet owner.',
        'This notification will NOT count against your monthly quota.',
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

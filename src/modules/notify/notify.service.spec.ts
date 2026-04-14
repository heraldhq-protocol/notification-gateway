import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotifyService } from './notify.service';
import { PrismaService } from '../../database/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { QueueService } from '../queue/queue.service';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import type { IdentityAccount } from '../../common/types/notification.types';

// ── Mocks ─────────────────────────────────────────────────────────

const mockPrisma = {
  notification: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
};

const mockRoutingService = {
  resolveIdentity: jest.fn(),
};

const mockQueueService = {
  enqueueNotification: jest.fn(),
};

// ── Fixtures ──────────────────────────────────────────────────────

const mockProtocol: AuthenticatedProtocol = {
  protocolId: 'proto-1',
  protocolPubkey: 'TestProtocolPubkey123456789',
  tier: 0,
  scopes: ['notify:write'],
  environment: 'live',
  isActive: true,
  name: 'TestProtocol',
};

const mockIdentity: IdentityAccount = {
  owner: 'WalletPubkey12345678',
  encryptedEmail: new Uint8Array([1, 2, 3]),
  emailHash: new Uint8Array([4, 5, 6]),
  nonce: new Uint8Array([7, 8, 9]),
  registeredAt: 1700000000,
  optInAll: true,
  optInDefi: true,
  optInGovernance: true,
  optInMarketing: false,
  digestMode: false,
  channelEmail: true,
  channelTelegram: false,
  channelSms: false,
  encryptedTelegramId: new Uint8Array([]),
  telegramIdHash: new Uint8Array([]),
  nonceTelegram: new Uint8Array([]),
  encryptedPhone: new Uint8Array([]),
  phoneHash: new Uint8Array([]),
  nonceSms: new Uint8Array([]),
};

describe('NotifyService', () => {
  let service: NotifyService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotifyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RoutingService, useValue: mockRoutingService },
        { provide: QueueService, useValue: mockQueueService },
      ],
    }).compile();

    service = module.get<NotifyService>(NotifyService);
  });

  // ── Queue Notification ──────────────────────────────────────────

  describe('queueNotification', () => {
    it('should queue a notification successfully', async () => {
      mockRoutingService.resolveIdentity.mockResolvedValue(mockIdentity);
      mockPrisma.notification.create.mockResolvedValue({});
      mockQueueService.enqueueNotification.mockResolvedValue(undefined);

      const result = await service.queueNotification(
        {
          wallet: 'WalletPubkey12345678',
          subject: 'Test',
          body: 'Hello',
          category: 'defi',
        },
        mockProtocol,
      );

      expect(result.status).toBe('queued');
      expect(result.notification_id).toBeDefined();
      expect(result.recipient_registered).toBe(true);
      expect(result.estimated_delivery_ms).toBe(2500);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockQueueService.enqueueNotification).toHaveBeenCalledTimes(1);
    });

    it('should return duplicate for existing idempotency key', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({
        id: 'existing-notif-id',
        receiptTx: 'tx123',
      });

      const result = await service.queueNotification(
        {
          wallet: 'WalletPubkey12345678',
          subject: 'Test',
          body: 'Hello',
          idempotencyKey: 'dupe-key-123',
        },
        mockProtocol,
      );

      expect(result.status).toBe('duplicate');
      expect(result.notification_id).toBe('existing-notif-id');
      expect(result.receipt_tx).toBe('tx123');
      expect(mockRoutingService.resolveIdentity).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for unregistered wallets', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue(null);
      mockRoutingService.resolveIdentity.mockResolvedValue(null);

      await expect(
        service.queueNotification(
          { wallet: 'UnregisteredWallet', subject: 'Test', body: 'Hello' },
          mockProtocol,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return opted_out for wallets that opted out of the category', async () => {
      const optedOutIdentity = { ...mockIdentity, optInDefi: false };
      mockRoutingService.resolveIdentity.mockResolvedValue(optedOutIdentity);
      mockPrisma.notification.create.mockResolvedValue({});

      const result = await service.queueNotification(
        {
          wallet: 'WalletPubkey12345678',
          subject: 'Test',
          body: 'Hello',
          category: 'defi',
        },
        mockProtocol,
      );

      expect(result.status).toBe('opted_out');
      expect(mockQueueService.enqueueNotification).not.toHaveBeenCalled();
    });

    it('should allow system notifications even if optInAll is false', async () => {
      const noOptInIdentity = { ...mockIdentity, optInAll: true };
      mockRoutingService.resolveIdentity.mockResolvedValue(noOptInIdentity);
      mockPrisma.notification.create.mockResolvedValue({});
      mockQueueService.enqueueNotification.mockResolvedValue(undefined);

      const result = await service.queueNotification(
        {
          wallet: 'WalletPubkey12345678',
          subject: 'System',
          body: 'Update',
          category: 'system',
        },
        mockProtocol,
      );

      expect(result.status).toBe('queued');
    });

    it('should hash wallet address before storing', async () => {
      mockRoutingService.resolveIdentity.mockResolvedValue(mockIdentity);
      mockPrisma.notification.create.mockResolvedValue({});
      mockQueueService.enqueueNotification.mockResolvedValue(undefined);

      await service.queueNotification(
        { wallet: 'WalletPubkey12345678', subject: 'Test', body: 'Hello' },
        mockProtocol,
      );

      // walletHash should be a 64-char hex string (SHA-256)
      const createCall = mockPrisma.notification.create.mock.calls[0][0];
      expect(createCall.data.walletHash).toHaveLength(64);
      expect(createCall.data.walletHash).not.toBe('WalletPubkey12345678');
    });
  });

  // ── Get Notification Status ─────────────────────────────────────

  describe('getNotificationStatus', () => {
    it('should return notification status with formatted dates', async () => {
      const now = new Date();
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'notif-123',
        status: 'delivered',
        category: 'defi',
        queuedAt: now,
        deliveredAt: now,
        receiptTx: 'tx456',
        emailProvider: 'ses',
        bounce: false,
      });

      const result = await service.getNotificationStatus(
        'notif-123',
        'proto-1',
      );

      expect(result.notification_id).toBe('notif-123');
      expect(result.status).toBe('delivered');
      expect(result.created_at).toBe(now.toISOString());
      expect(result.delivered_at).toBe(now.toISOString());
      expect(result.receipt_tx).toBe('tx456');
      expect(result.email_provider).toBe('ses');
      expect(result.bounce).toBe(false);
    });

    it('should throw NotFoundException for non-existent notification', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      await expect(
        service.getNotificationStatus('unknown-id', 'proto-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── List Notifications ──────────────────────────────────────────

  describe('listNotifications', () => {
    it('should return paginated results', async () => {
      const now = new Date();
      mockPrisma.notification.findMany.mockResolvedValue([
        {
          id: 'n1',
          status: 'delivered',
          category: 'defi',
          queuedAt: now,
          deliveredAt: now,
          receiptTx: null,
          bounce: false,
        },
        {
          id: 'n2',
          status: 'queued',
          category: 'governance',
          queuedAt: now,
          deliveredAt: null,
          receiptTx: null,
          bounce: false,
        },
      ]);
      mockPrisma.notification.count.mockResolvedValue(25);

      const result = await service.listNotifications('proto-1', 1, 10);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(3); // ceil(25/10)
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, NotFoundException } from '@nestjs/common';
import { NotifyService } from './notify.service';
import { PrismaService } from '../../database/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import type { IdentityAccount } from '../../common/types/notification.types';

// ── Mock entire module chains that touch @herald-protocol/sdk (ESM) ─
jest.mock('../../solana/solana.service', () => ({ SolanaService: jest.fn() }));
jest.mock('../routing/routing.service', () => ({
  RoutingService: jest.fn().mockImplementation(() => ({
    resolveIdentity: jest.fn(),
  })),
}));
jest.mock('../routing/sandbox-routing.service', () => ({
  SandboxRoutingService: jest.fn().mockImplementation(() => ({
    addTestPrefix: jest.fn((s: string) => `[HERALD TEST] ${s}`),
    resolveDevnetWallet: jest.fn(),
  })),
}));
jest.mock('../sandbox/sandbox.service', () => ({
  SandboxService: jest.fn().mockImplementation(() => ({
    validateSandboxKey: jest.fn(),
    incrementUsage: jest.fn(),
  })),
}));

import { RoutingService } from '../routing/routing.service';
import { SandboxRoutingService } from '../routing/sandbox-routing.service';
import { SandboxService } from '../sandbox/sandbox.service';

// ── Mocks ─────────────────────────────────────────────────────────

const mockPrisma = {
  notification: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  protocol_settings: {
    findUnique: jest.fn(),
  },
};

const mockRoutingService = {
  resolveIdentity: jest.fn(),
};

const mockSandboxRoutingService = {
  addTestPrefix: jest.fn((subject: string) => `[HERALD TEST] ${subject}`),
  resolveDevnetWallet: jest.fn(),
};

const mockSandboxService = {
  validateSandboxKey: jest.fn(),
  incrementUsage: jest.fn(),
};

const mockQueueService = {
  enqueueNotification: jest.fn(),
};

// ── Fixtures ──────────────────────────────────────────────────────

const mockProtocol: AuthenticatedProtocol = {
  protocolId: 'proto-1',
  protocolPubkey: 'TestProtocolPubkey123456789',
  apiKeyId: 'key-1',
  tier: 0,
  scopes: ['notify:write'],
  environment: 'live',
  isActive: true,
  name: 'TestProtocol',
};

const mockSandboxProtocol: AuthenticatedProtocol = {
  ...mockProtocol,
  environment: 'sandbox',
  isTestKey: true,
  testKeyType: 'integration',
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
        { provide: SandboxRoutingService, useValue: mockSandboxRoutingService },
        { provide: SandboxService, useValue: mockSandboxService },
        { provide: QueueService, useValue: mockQueueService },
      ],
    }).compile();

    service = module.get<NotifyService>(NotifyService);
  });

  // ── Production: Queue Notification ─────────────────────────────

  describe('queueNotification (production)', () => {
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

  // ── Sandbox path ─────────────────────────────────────────────────

  describe('queueNotification (sandbox)', () => {
    const sandboxDto = {
      wallet: 'SandboxWallet123',
      subject: 'Liquidation Warning',
      body: 'Your position is at risk.',
      category: 'defi',
    };

    const quotaAllowed = {
      allowed: true,
      isSandbox: true,
      apiKeyId: 'key-1',
      dailyLimit: 100,
      remainingToday: 75,
    };

    it('should queue sandbox notification with [HERALD TEST] prefix', async () => {
      // devnet resolution returns no result — falls back to test contacts
      mockSandboxRoutingService.resolveDevnetWallet.mockResolvedValue({
        resolved: false,
        channels: {},
        identity: null,
      });
      mockSandboxService.validateSandboxKey.mockResolvedValue(quotaAllowed);
      mockPrisma.notification.findFirst.mockResolvedValue(null); // no duplicate
      mockPrisma.protocol_settings.findUnique.mockResolvedValue({
        test_email: 'dev@protocol.io',
        test_telegram_id: null,
        test_phone: null,
      });
      mockPrisma.notification.create.mockResolvedValue({});
      mockQueueService.enqueueNotification.mockResolvedValue(undefined);
      mockSandboxService.incrementUsage.mockResolvedValue(undefined);

      const result = await service.queueNotification(
        sandboxDto,
        mockSandboxProtocol,
      );

      expect(result.status).toBe('queued');
      expect(result.environment).toBe('sandbox');
      expect(result.sandbox_mode).toBe(true);
      expect(result.test_contact?.email).toMatch(/^de\*\*\*@/);

      // Subject must have been prefixed via SandboxRoutingService
      const enqueueCall = mockQueueService.enqueueNotification.mock.calls[0][0];
      expect(enqueueCall.subject).toBe('[HERALD TEST] Liquidation Warning');
      expect(enqueueCall.isSandbox).toBe(true);

      // Quota must be incremented after successful send
      expect(mockSandboxService.incrementUsage).toHaveBeenCalledWith('key-1');
    });

    it('should block when sandbox daily quota is exceeded', async () => {
      mockSandboxRoutingService.resolveDevnetWallet.mockResolvedValue({
        resolved: false,
        channels: {},
        identity: null,
      });
      mockSandboxService.validateSandboxKey.mockResolvedValue({
        allowed: false,
        isSandbox: true,
        dailyLimit: 100,
        remainingToday: 0,
        error: 'Sandbox daily limit exceeded (100/day)',
        errorCode: 'SANDBOX_LIMIT_EXCEEDED',
      });

      await expect(
        service.queueNotification(sandboxDto, mockSandboxProtocol),
      ).rejects.toThrow(HttpException);

      expect(mockQueueService.enqueueNotification).not.toHaveBeenCalled();
      expect(mockSandboxService.incrementUsage).not.toHaveBeenCalled();
    });

    it('should return failed status when no test contact is configured', async () => {
      mockSandboxRoutingService.resolveDevnetWallet.mockResolvedValue({
        resolved: false,
        channels: {},
        identity: null,
      });
      mockSandboxService.validateSandboxKey.mockResolvedValue(quotaAllowed);
      mockPrisma.notification.findFirst.mockResolvedValue(null);
      mockPrisma.protocol_settings.findUnique.mockResolvedValue({
        test_email: null,
        test_telegram_id: null,
        test_phone: null,
      });
      mockPrisma.notification.create.mockResolvedValue({});

      const result = await service.queueNotification(
        sandboxDto,
        mockSandboxProtocol,
      );

      expect(result.status).toBe('failed');
      expect(result.error_code).toBe('SANDBOX_NO_TEST_CONTACT');
      expect(result.sandbox_mode).toBe(true);
      expect(mockQueueService.enqueueNotification).not.toHaveBeenCalled();
      // Quota must NOT be incremented on failed delivery
      expect(mockSandboxService.incrementUsage).not.toHaveBeenCalled();
    });

    it('should return duplicate within the 1-hour sandbox idempotency window', async () => {
      mockSandboxRoutingService.resolveDevnetWallet.mockResolvedValue({
        resolved: false,
        channels: {},
        identity: null,
      });
      mockSandboxService.validateSandboxKey.mockResolvedValue(quotaAllowed);
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'dup-notif-id',
      });

      const result = await service.queueNotification(
        { ...sandboxDto, idempotencyKey: 'idem-abc' },
        mockSandboxProtocol,
      );

      expect(result.status).toBe('duplicate');
      expect(result.sandbox_mode).toBe(true);
      expect(mockQueueService.enqueueNotification).not.toHaveBeenCalled();
    });

    it('should write receipt=false for all sandbox notifications', async () => {
      mockSandboxRoutingService.resolveDevnetWallet.mockResolvedValue({
        resolved: false,
        channels: {},
        identity: null,
      });
      mockSandboxService.validateSandboxKey.mockResolvedValue(quotaAllowed);
      mockPrisma.notification.findFirst.mockResolvedValue(null);
      mockPrisma.protocol_settings.findUnique.mockResolvedValue({
        test_email: 'dev@protocol.io',
        test_telegram_id: null,
        test_phone: null,
      });
      mockPrisma.notification.create.mockResolvedValue({});
      mockQueueService.enqueueNotification.mockResolvedValue(undefined);
      mockSandboxService.incrementUsage.mockResolvedValue(undefined);

      await service.queueNotification(sandboxDto, mockSandboxProtocol);

      const createCall = mockPrisma.notification.create.mock.calls[0][0];
      expect(createCall.data.writeReceipt).toBe(false);

      const enqueueCall = mockQueueService.enqueueNotification.mock.calls[0][0];
      expect(enqueueCall.writeReceipt).toBe(false);
    });

    it('should deliver to devnet-resolved channels when wallet is registered on devnet', async () => {
      mockSandboxRoutingService.resolveDevnetWallet.mockResolvedValue({
        resolved: true,
        channels: {
          email: 'devnetuser@example.com',
          telegramChatId: null,
          phone: null,
        },
        identity: {
          owner: 'DevnetWallet1234',
          optInAll: true,
          optInDefi: true,
          optInGovernance: true,
          optInMarketing: false,
          digestMode: false,
          channelEmail: true,
          channelTelegram: false,
          channelSms: false,
          encryptedEmail: new Uint8Array([]),
          emailHash: new Uint8Array([]),
          nonce: new Uint8Array([]),
          registeredAt: 1700000000,
          encryptedTelegramId: new Uint8Array([]),
          telegramIdHash: new Uint8Array([]),
          nonceTelegram: new Uint8Array([]),
          encryptedPhone: new Uint8Array([]),
          phoneHash: new Uint8Array([]),
          nonceSms: new Uint8Array([]),
        },
      });
      mockSandboxService.validateSandboxKey.mockResolvedValue(quotaAllowed);
      mockPrisma.notification.findFirst.mockResolvedValue(null);
      mockPrisma.notification.create.mockResolvedValue({});
      mockQueueService.enqueueNotification.mockResolvedValue(undefined);
      mockSandboxService.incrementUsage.mockResolvedValue(undefined);

      const result = await service.queueNotification(
        sandboxDto,
        mockSandboxProtocol,
      );

      expect(result.status).toBe('queued');
      expect(result.recipient_registered).toBe(true);
      expect(result.sandbox_mode).toBe(true);
      expect(result.test_contact?.email).toMatch(/^de\*\*\*@/);
      expect(mockPrisma.protocol_settings.findUnique).not.toHaveBeenCalled();

      const enqueueCall = mockQueueService.enqueueNotification.mock.calls[0][0];
      expect(enqueueCall.testContact.email).toBe('devnetuser@example.com');
      expect(enqueueCall.isSandbox).toBe(true);
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

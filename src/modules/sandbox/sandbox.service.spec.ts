import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SandboxService, TestKeyType } from './sandbox.service';
import { PrismaService } from '../../database/prisma.service';

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  del: jest.fn(),
};

const mockPrisma = {
  apiKey: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  sandboxReceipt: {
    create: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

describe('SandboxService', () => {
  let service: SandboxService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SandboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
      ],
    }).compile();

    service = module.get<SandboxService>(SandboxService);
  });

  describe('isTestKey', () => {
    it('should return true for keys starting with hrld_test_', () => {
      expect(
        service.isTestKey('hrld_test_7yN1pKq4mSwBvRsXjM9eJcGoFb2AiYuV'),
      ).toBe(true);
    });

    it('should return false for production keys', () => {
      expect(
        service.isTestKey('hrld_live_4xR9mKp2nQwBvTsYjL8dHcFoEa3ZiXuW'),
      ).toBe(false);
    });

    it('should return false for invalid key format', () => {
      expect(service.isTestKey('invalid-key')).toBe(false);
    });
  });

  describe('isTestKeyByEnvironment', () => {
    it('should return true for sandbox environment', () => {
      expect(service.isTestKeyByEnvironment('sandbox')).toBe(true);
    });

    it('should return true for test environment', () => {
      expect(service.isTestKeyByEnvironment('test')).toBe(true);
    });

    it('should return false for production environment', () => {
      expect(service.isTestKeyByEnvironment('production')).toBe(false);
    });

    it('should return false for live environment', () => {
      expect(service.isTestKeyByEnvironment('live')).toBe(false);
    });
  });

  describe('getSandboxConfig', () => {
    it('should return null for production keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      const result = await service.getSandboxConfig('key-123');
      expect(result).toBeNull();
    });

    it('should return sandbox config for test keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        isTestKey: true,
        testKeyType: 'integration',
        testDailyLimit: 100,
        testNotificationsSent: 0,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockRedis.get.mockResolvedValue('50');

      const result = await service.getSandboxConfig('key-123');

      expect(result).not.toBeNull();
      expect(result!.isSandbox).toBe(true);
      expect(result!.testKeyType).toBe('integration');
      expect(result!.dailyLimit).toBe(100);
      expect(result!.remainingToday).toBe(50);
    });

    it('should indicate expiration for expired keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        isTestKey: true,
        testKeyType: 'integration',
        testDailyLimit: 100,
        testNotificationsSent: 0,
        expiresAt: new Date(Date.now() - 86400000), // expired
      });
      mockRedis.get.mockResolvedValue('0');

      const result = await service.getSandboxConfig('key-123');

      expect(result).not.toBeNull();
      expect(result!.isExpired).toBe(true);
    });
  });

  describe('validateSandboxKey', () => {
    it('should return error for non-existent API key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      const result = await service.validateSandboxKey('non-existent');

      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe('AUTH_INVALID_KEY');
    });

    it('should return error for revoked keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isTestKey: true,
        isRevoked: true,
      });

      const result = await service.validateSandboxKey('key-1');

      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe('AUTH_KEY_REVOKED');
    });

    it('should return error for expired keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isTestKey: true,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 86400000),
      });

      const result = await service.validateSandboxKey('key-1');

      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe('SANDBOX_KEY_EXPIRED');
    });

    it('should allow valid test key with available quota', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isTestKey: true,
        testKeyType: 'integration',
        testDailyLimit: 100,
        expiresAt: new Date(Date.now() + 86400000),
        isRevoked: false,
      });
      mockRedis.get.mockResolvedValue('50');

      const result = await service.validateSandboxKey('key-1');

      expect(result.allowed).toBe(true);
      expect(result.isSandbox).toBe(true);
      expect(result.remainingToday).toBe(50);
    });

    it('should deny when quota exceeded', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isTestKey: true,
        testKeyType: 'integration',
        testDailyLimit: 100,
        expiresAt: new Date(Date.now() + 86400000),
        isRevoked: false,
      });
      mockRedis.get.mockResolvedValue('100');

      const result = await service.validateSandboxKey('key-1');

      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe('SANDBOX_LIMIT_EXCEEDED');
      expect(result.remainingToday).toBe(0);
    });
  });

  describe('createTestKey', () => {
    it('should create a test key with default 14-day expiration', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'new-key-id' });
      mockPrisma.apiKey.update.mockResolvedValue({});

      const result = await service.createTestKey('protocol-123');

      expect(result.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 13 * 86400000,
      ); // > 13 days
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 15 * 86400000,
      ); // <= 15 days
      expect(mockPrisma.apiKey.create).toHaveBeenCalled();
    });

    it('should create test key with protocol type and higher limit', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'new-key-id' });
      mockPrisma.apiKey.update.mockResolvedValue({});

      await service.createTestKey('protocol-123', 'protocol');

      const createCall = mockPrisma.apiKey.create.mock.calls[0][0];
      expect(createCall.data.testKeyType).toBe('protocol');
      expect(createCall.data.testDailyLimit).toBe(500);
    });

    it('should create test key with full type and 1000 limit', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'new-key-id' });
      mockPrisma.apiKey.update.mockResolvedValue({});

      await service.createTestKey('protocol-123', 'full');

      const createCall = mockPrisma.apiKey.create.mock.calls[0][0];
      expect(createCall.data.testKeyType).toBe('full');
      expect(createCall.data.testDailyLimit).toBe(1000);
    });

    it('should throw when IP limit exceeded', async () => {
      mockRedis.get.mockResolvedValue('5'); // at limit

      await expect(
        service.createTestKey('protocol-123', 'integration', '192.168.1.1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('incrementUsage', () => {
    it('should increment Redis counter for test keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isTestKey: true,
      });
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      await service.incrementUsage('key-1');

      expect(mockRedis.incr).toHaveBeenCalledWith('sandbox:daily:key-1');
    });

    it('should not increment for production keys', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        isTestKey: false,
      });

      await service.incrementUsage('key-1');

      expect(mockRedis.incr).not.toHaveBeenCalled();
    });
  });

  describe('recordSandboxReceipt', () => {
    it('should create a sandbox receipt record', async () => {
      mockPrisma.sandboxReceipt.create.mockResolvedValue({});

      await service.recordSandboxReceipt({
        apiKeyId: 'key-1',
        notificationId: 'notif-1',
        walletHash: 'abc123',
        subject: 'Test Notification',
        status: 'delivered',
        devnetTx: 'tx123',
        channel: 'email',
      });

      expect(mockPrisma.sandboxReceipt.create).toHaveBeenCalledWith({
        data: {
          apiKeyId: 'key-1',
          notificationId: 'notif-1',
          walletHash: 'abc123',
          subject: 'Test Notification',
          status: 'delivered',
          devnetTx: 'tx123',
          channel: 'email',
          deliveredAt: expect.any(Date),
        },
      });
    });
  });

  describe('getSandboxReceipts', () => {
    it('should return receipts from last 24 hours', async () => {
      const mockReceipts = [
        {
          id: 'receipt-1',
          walletHash: 'abc',
          subject: 'Test',
          status: 'delivered',
          channel: 'email',
          devnetTx: null,
          deliveredAt: new Date(),
          createdAt: new Date(),
        },
      ];
      mockPrisma.sandboxReceipt.findMany.mockResolvedValue(mockReceipts);

      const result = await service.getSandboxReceipts('key-1');

      expect(result).toHaveLength(1);
      expect(mockPrisma.sandboxReceipt.findMany).toHaveBeenCalledWith({
        where: {
          apiKeyId: 'key-1',
          createdAt: { gte: expect.any(Date) },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: expect.anything(),
      });
    });

    it('should respect limit parameter', async () => {
      mockPrisma.sandboxReceipt.findMany.mockResolvedValue([]);

      await service.getSandboxReceipts('key-1', 10);

      expect(mockPrisma.sandboxReceipt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });
  });

  describe('cleanupOldReceipts', () => {
    it('should delete receipts older than 24 hours', async () => {
      mockPrisma.sandboxReceipt.deleteMany.mockResolvedValue({ count: 5 });

      const result = await service.cleanupOldReceipts();

      expect(result).toBe(5);
      expect(mockPrisma.sandboxReceipt.deleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: expect.any(Date) } },
      });
    });
  });

  describe('hashIp', () => {
    it('should produce consistent SHA-256 hashes', () => {
      const hash1 = service.hashIp('192.168.1.1');
      const hash2 = service.hashIp('192.168.1.1');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('should produce different hashes for different IPs', () => {
      const hash1 = service.hashIp('192.168.1.1');
      const hash2 = service.hashIp('10.0.0.1');
      expect(hash1).not.toBe(hash2);
    });
  });
});

describe('TestKeyType enum values', () => {
  it('should have valid test key types', () => {
    const validTypes: TestKeyType[] = ['integration', 'protocol', 'full'];
    expect(validTypes).toContain('integration');
    expect(validTypes).toContain('protocol');
    expect(validTypes).toContain('full');
  });
});

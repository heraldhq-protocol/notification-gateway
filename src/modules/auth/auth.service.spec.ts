import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../../database/prisma.service';
import { Redis } from 'ioredis';

// ── Mocks ─────────────────────────────────────────────────────────

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
};

const mockPrisma = {
  apiKey: {
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: Redis, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── Key Generation ──────────────────────────────────────────────

  describe('generateApiKey', () => {
    it('should generate a production key with hrld_live_ prefix', () => {
      const key = service.generateApiKey('production');
      expect(key.plainText).toMatch(/^hrld_live_[1-9A-HJ-NP-Za-km-z]+$/);
      expect(key.hash).toHaveLength(64); // SHA-256 hex
      expect(key.prefix).toBe(key.plainText.substring(0, 16));
    });

    it('should generate a sandbox key with hrld_test_ prefix', () => {
      const key = service.generateApiKey('sandbox');
      expect(key.plainText).toMatch(/^hrld_test_[1-9A-HJ-NP-Za-km-z]+$/);
    });

    it('should generate unique keys on each call', () => {
      const key1 = service.generateApiKey('production');
      const key2 = service.generateApiKey('production');
      expect(key1.plainText).not.toBe(key2.plainText);
      expect(key1.hash).not.toBe(key2.hash);
    });
  });

  // ── Key Hashing ─────────────────────────────────────────────────

  describe('hashKey', () => {
    it('should produce consistent SHA-256 hashes', () => {
      const hash1 = service.hashKey('hrld_live_test123');
      const hash2 = service.hashKey('hrld_live_test123');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = service.hashKey('hrld_live_aaa');
      const hash2 = service.hashKey('hrld_live_bbb');
      expect(hash1).not.toBe(hash2);
    });
  });

  // ── Key Validation ──────────────────────────────────────────────

  describe('validateApiKey', () => {
    it('should return null for invalid key format', async () => {
      const result = await service.validateApiKey('invalid-key');
      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should return cached protocol from Redis on cache hit', async () => {
      const cached = {
        protocolId: 'proto-1',
        protocolPubkey: 'abc123',
        tier: 1,
        scopes: ['notify:write'],
        environment: 'live',
        isActive: true,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const key = service.generateApiKey('production');
      const result = await service.validateApiKey(key.plainText);

      expect(result).toEqual(cached);
      expect(mockPrisma.apiKey.findFirst).not.toHaveBeenCalled();
    });

    it('should fall through to PG on Redis cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.apiKey.findFirst.mockResolvedValue({
        id: 'key-1',
        scopes: ['notify:write'],
        environment: 'live',
        protocol: {
          id: 'proto-1',
          protocolPubkey: 'abc123',
          tier: 0,
          isActive: true,
          isSuspended: false,
          sendsThisPeriod: 42n,
        },
      });

      const key = service.generateApiKey('production');
      const result = await service.validateApiKey(key.plainText);

      expect(result).not.toBeNull();
      expect(result!.protocolId).toBe('proto-1');
      expect(result!.tier).toBe(0);
      expect(mockRedis.setex).toHaveBeenCalled(); // should cache result
    });

    it('should return null if key not found in PG', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.apiKey.findFirst.mockResolvedValue(null);

      const key = service.generateApiKey('production');
      const result = await service.validateApiKey(key.plainText);

      expect(result).toBeNull();
    });

    it('should throw UnauthorizedException for suspended protocols', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockPrisma.apiKey.findFirst.mockResolvedValue({
        id: 'key-1',
        scopes: ['notify:write'],
        environment: 'live',
        protocol: {
          id: 'proto-1',
          protocolPubkey: 'abc123',
          tier: 0,
          isActive: true,
          isSuspended: true,
          sendsThisPeriod: 0n,
        },
      });

      const key = service.generateApiKey('production');
      await expect(service.validateApiKey(key.plainText)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should gracefully handle Redis errors and fall through to PG', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis connection failed'));
      mockPrisma.apiKey.findFirst.mockResolvedValue({
        id: 'key-1',
        scopes: ['notify:write'],
        environment: 'live',
        protocol: {
          id: 'proto-1',
          protocolPubkey: 'abc123',
          tier: 1,
          isActive: true,
          isSuspended: false,
          sendsThisPeriod: 100n,
        },
      });

      const key = service.generateApiKey('production');
      const result = await service.validateApiKey(key.plainText);

      expect(result).not.toBeNull();
      expect(result!.protocolId).toBe('proto-1');
    });
  });

  // ── Cache Invalidation ──────────────────────────────────────────

  describe('invalidateCache', () => {
    it('should delete the cache key from Redis', async () => {
      await service.invalidateCache('abc123hash');
      expect(mockRedis.del).toHaveBeenCalledWith('auth:key:abc123hash');
    });
  });
});

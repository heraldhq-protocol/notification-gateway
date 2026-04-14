import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { RateLimitService } from './rate-limit.service';

// ── Mocks ─────────────────────────────────────────────────────────

const mockRedis = {
  eval: jest.fn(),
};

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [RateLimitService, { provide: Redis, useValue: mockRedis }],
    }).compile();

    service = module.get<RateLimitService>(RateLimitService);
  });

  // ── Tier Limits ─────────────────────────────────────────────────

  describe('getTierLimits', () => {
    it('should return Developer limits for tier 0', () => {
      const limits = service.getTierLimits(0);
      expect(limits.name).toBe('Developer');
      expect(limits.burstLimit).toBe(10);
      expect(limits.sendsPerMonth).toBe(1_000);
    });

    it('should return Growth limits for tier 1', () => {
      const limits = service.getTierLimits(1);
      expect(limits.name).toBe('Growth');
      expect(limits.burstLimit).toBe(100);
      expect(limits.sendsPerMonth).toBe(50_000);
    });

    it('should fall back to Developer for unknown tiers', () => {
      const limits = service.getTierLimits(99);
      expect(limits.name).toBe('Developer');
    });
  });

  // ── Monthly Quota ───────────────────────────────────────────────

  describe('checkMonthlyQuotaSimple', () => {
    it('should return true when under quota', () => {
      expect(service.checkMonthlyQuotaSimple(0, 500n)).toBe(true);
    });

    it('should return false when at quota', () => {
      expect(service.checkMonthlyQuotaSimple(0, 1000n)).toBe(false);
    });

    it('should return false when over quota', () => {
      expect(service.checkMonthlyQuotaSimple(0, 1500n)).toBe(false);
    });
  });

  // ── Rate Limits ─────────────────────────────────────────────────

  describe('checkAllLimits', () => {
    const defaultProtocol: any = {
      protocolId: 'proto-1',
      protocolPubkey: '7xR4mKp2nQ...',
      tier: 0,
      environment: 'production',
      sendsThisPeriod: 0n,
      scopes: ['notify:write'],
      isActive: true,
      overageEnabled: false,
    };

    it('should allow requests under the burst limit', async () => {
      mockRedis.eval.mockResolvedValue([1, 1000]);

      const result = await service.checkAllLimits(defaultProtocol);

      expect(result.allowed).toBe(true);
      expect(result.headers['X-RateLimit-Remaining']).toBe('9'); // burst 10 - 1 used
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should deny requests over the burst limit', async () => {
      mockRedis.eval.mockResolvedValue([15, 1000]); // 15 requests, over burst 10

      const result = await service.checkAllLimits(defaultProtocol);

      expect(result.allowed).toBe(false);
      expect(result.headers['X-RateLimit-Remaining']).toBe('0');
      expect(result.retryAfter).toBe(1);
    });

    it('should use correct tier burst limits', async () => {
      mockRedis.eval.mockResolvedValue([50, 1000]); // 50 requests

      // Tier 0 (burst 10): should deny
      const result0 = await service.checkAllLimits(defaultProtocol);
      expect(result0.allowed).toBe(false);

      // Tier 1 (burst 100): should allow
      const result1 = await service.checkAllLimits({
        ...defaultProtocol,
        tier: 1,
      });
      expect(result1.allowed).toBe(true);
      expect(result1.headers['X-RateLimit-Remaining']).toBe('50'); // 100 - 50
    });

    it('should fallback gracefully on redis failure', async () => {
      mockRedis.eval.mockRejectedValue(new Error('Redis error'));

      const result = await service.checkAllLimits(defaultProtocol);

      expect(result.allowed).toBe(true);
      expect(result.headers['X-RateLimit-Remaining']).toBe('10');
    });
  });
});

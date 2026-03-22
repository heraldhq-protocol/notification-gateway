import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { RateLimitService } from './rate-limit.service';

// ── Mocks ─────────────────────────────────────────────────────────

const mockRedis = {
  multi: jest.fn(),
};

const mockPipeline = {
  zremrangebyscore: jest.fn().mockReturnThis(),
  zadd: jest.fn().mockReturnThis(),
  zcard: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn(),
};

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.multi.mockReturnValue(mockPipeline);

    const module: TestingModule = await Test.createTestingModule({
      providers: [RateLimitService, { provide: Redis, useValue: mockRedis }],
    }).compile();

    service = module.get<RateLimitService>(RateLimitService);
  });

  // ── Tier Limits ─────────────────────────────────────────────────

  describe('getTierLimits', () => {
    it('should return Developer limits for tier 0', () => {
      const limits = service.getTierLimits(0);
      expect(limits).toEqual({ perSecond: 2, burst: 10, monthly: 1_000 });
    });

    it('should return Growth limits for tier 1', () => {
      const limits = service.getTierLimits(1);
      expect(limits).toEqual({ perSecond: 20, burst: 100, monthly: 50_000 });
    });

    it('should return Scale limits for tier 2', () => {
      const limits = service.getTierLimits(2);
      expect(limits).toEqual({ perSecond: 100, burst: 500, monthly: 250_000 });
    });

    it('should return Enterprise limits for tier 3', () => {
      const limits = service.getTierLimits(3);
      expect(limits).toEqual({
        perSecond: 500,
        burst: 2000,
        monthly: 1_000_000,
      });
    });

    it('should fall back to Developer for unknown tiers', () => {
      const limits = service.getTierLimits(99);
      expect(limits).toEqual({ perSecond: 2, burst: 10, monthly: 1_000 });
    });
  });

  // ── Monthly Quota ───────────────────────────────────────────────

  describe('checkMonthlyQuota', () => {
    it('should return true when under quota', () => {
      expect(service.checkMonthlyQuota(0, 500n)).toBe(true);
    });

    it('should return false when at quota', () => {
      expect(service.checkMonthlyQuota(0, 1000n)).toBe(false);
    });

    it('should return false when over quota', () => {
      expect(service.checkMonthlyQuota(0, 1500n)).toBe(false);
    });

    it('should check against correct tier limit', () => {
      expect(service.checkMonthlyQuota(1, 49_999n)).toBe(true); // Growth < 50k
      expect(service.checkMonthlyQuota(1, 50_000n)).toBe(false); // Growth >= 50k
    });
  });

  // ── Sliding Window ──────────────────────────────────────────────

  describe('checkAndIncrement', () => {
    it('should allow requests under the burst limit', async () => {
      mockPipeline.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 5], // zcard — 5 requests in window
        [null, 1], // expire
      ]);

      const result = await service.checkAndIncrement('proto-1', 0);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5); // burst 10 - 5 used
      expect(mockRedis.multi).toHaveBeenCalled();
    });

    it('should deny requests over the burst limit', async () => {
      mockPipeline.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 15], // zcard — 15 requests, over burst 10
        [null, 1],
      ]);

      const result = await service.checkAndIncrement('proto-1', 0);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBe(1);
    });

    it('should use correct tier burst limits', async () => {
      mockPipeline.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 50], // zcard — 50 requests
        [null, 1],
      ]);

      // Tier 0 (burst 10): should deny
      const result0 = await service.checkAndIncrement('proto-1', 0);
      expect(result0.allowed).toBe(false);

      // Tier 1 (burst 100): should allow
      const result1 = await service.checkAndIncrement('proto-1', 1);
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(50); // 100 - 50
    });

    it('should fallback gracefully on null pipeline result', async () => {
      mockPipeline.exec.mockResolvedValue(null);

      const result = await service.checkAndIncrement('proto-1', 0);

      expect(result.allowed).toBe(true);
    });
  });
});

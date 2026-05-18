import type { ConfigService } from '@nestjs/config';
import { RpcManagerService } from './rpc-manager.service';

// ── Mocks ─────────────────────────────────────────────────────────

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue('http://localhost:8899'),
  get: jest.fn().mockReturnValue('http://fallback:8899'),
};

describe('RpcManagerService', () => {
  let service: RpcManagerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RpcManagerService(mockConfigService as any);
  });

  describe('getConnection', () => {
    it('should return the primary connection initially', () => {
      const conn = service.getConnection();
      expect(conn).toBeDefined();
      expect(conn.rpcEndpoint).toBe('http://localhost:8899');
    });

    it('should remain on primary after a few failures (under threshold)', () => {
      service.recordFailure();
      service.recordFailure();
      service.recordFailure();

      const conn = service.getConnection();
      expect(conn.rpcEndpoint).toBe('http://localhost:8899');
    });

    it('should switch to fallback after 6+ failures', () => {
      for (let i = 0; i < 6; i++) service.recordFailure();

      const conn = service.getConnection();
      expect(conn.rpcEndpoint).toBe('http://fallback:8899');
    });
  });

  describe('recordSuccess', () => {
    it('should decrement failure count', () => {
      service.recordFailure();
      service.recordFailure();
      service.recordSuccess();

      // Still on primary (only 1 net failure)
      const conn = service.getConnection();
      expect(conn.rpcEndpoint).toBe('http://localhost:8899');
    });
  });

  describe('circuit breaker recovery', () => {
    it('should attempt recovery after 30s', () => {
      // Trigger failover
      for (let i = 0; i < 6; i++) service.recordFailure();
      expect(service.getConnection().rpcEndpoint).toBe('http://fallback:8899');

      // Simulate 30s+ elapsed by manipulating lastFailureAt
      (service as any).lastFailureAt = new Date(Date.now() - 31_000);

      const conn = service.getConnection();
      expect(conn.rpcEndpoint).toBe('http://localhost:8899'); // back to primary
    });
  });

  describe('no fallback configured', () => {
    it('should stay on primary even after many failures', () => {
      const noFallbackConfig = {
        getOrThrow: jest.fn().mockReturnValue('http://localhost:8899'),
        get: jest.fn().mockReturnValue(undefined), // no fallback
      };
      const svc = new RpcManagerService(noFallbackConfig as any);

      for (let i = 0; i < 10; i++) svc.recordFailure();

      const conn = svc.getConnection();
      expect(conn.rpcEndpoint).toBe('http://localhost:8899');
    });
  });
});

import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

// ── Mocks ─────────────────────────────────────────────────────────

const mockAuthService = {
  validateApiKey: jest.fn(),
};

const mockRateLimitService = {
  checkAndIncrement: jest.fn(),
  checkMonthlyQuota: jest.fn(),
};

const mockReflector = {
  getAllAndOverride: jest.fn(),
};

function createMockExecutionContext(authHeader?: string): ExecutionContext {
  const request = {
    headers: { authorization: authHeader },
    protocol: undefined,
  };
  const response = {
    header: jest.fn(),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

describe('AuthGuard', () => {
  let guard: AuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AuthGuard(mockAuthService as any);
  });

  it('should deny requests without Authorization header', async () => {
    const ctx = createMockExecutionContext();
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('should deny requests with non-Bearer authorization', async () => {
    const ctx = createMockExecutionContext('Basic abc123');
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('should deny requests with invalid API key', async () => {
    mockAuthService.validateApiKey.mockResolvedValue(null);
    const ctx = createMockExecutionContext(
      'Bearer hrld_live_invalidkey123456789012345',
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('should allow requests with valid API key', async () => {
    const protocol = {
      protocolId: 'proto-1',
      protocolPubkey: 'abc123',
      tier: 0,
      scopes: ['notify:write'],
      environment: 'live',
      isActive: true,
      sendsThisPeriod: 10n,
    };
    mockAuthService.validateApiKey.mockResolvedValue(protocol);
    mockRateLimitService.checkAndIncrement.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: 123,
    });
    mockRateLimitService.checkMonthlyQuota.mockReturnValue(true);

    const ctx = createMockExecutionContext(
      'Bearer hrld_live_validkey12345678901234567890',
    );
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
  });

  it('should deny rate-limited requests', async () => {
    const protocol = {
      protocolId: 'proto-1',
      protocolPubkey: 'abc123',
      tier: 0,
      scopes: ['notify:write'],
      environment: 'live',
      isActive: true,
      sendsThisPeriod: 10n,
    };
    mockAuthService.validateApiKey.mockResolvedValue(protocol);
    mockRateLimitService.checkAndIncrement.mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 123,
      retryAfter: 1,
    });

    const ctx = createMockExecutionContext(
      'Bearer hrld_live_validkey12345678901234567890',
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });
});

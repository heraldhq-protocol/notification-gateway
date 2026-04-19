import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

// ── Mocks ─────────────────────────────────────────────────────────

const mockAuthService = {
  validateApiKey: jest.fn(),
};

function createMockExecutionContext(authHeader?: string): ExecutionContext {
  const request = {
    headers: { authorization: authHeader },
    authProtocol: undefined,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: jest.fn() }),
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
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should deny requests with non-Bearer authorization', async () => {
    const ctx = createMockExecutionContext('Basic abc123');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should deny requests with invalid API key', async () => {
    mockAuthService.validateApiKey.mockResolvedValue(null);
    const ctx = createMockExecutionContext(
      'Bearer hrld_live_invalidkey123456789012345',
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should allow requests with valid API key and attach authProtocol', async () => {
    const protocol = {
      protocolId: 'proto-1',
      protocolPubkey: 'abc123',
      apiKeyId: 'key-1',
      tier: 0,
      scopes: ['notify:write'],
      environment: 'live',
      isActive: true,
      sendsThisPeriod: 10n,
    };
    mockAuthService.validateApiKey.mockResolvedValue(protocol);

    const ctx = createMockExecutionContext(
      'Bearer hrld_live_validkey12345678901234567890',
    );
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    // authProtocol must be attached to the request
    expect(ctx.switchToHttp().getRequest().authProtocol).toEqual(protocol);
  });

  it('should deny requests with revoked or missing key', async () => {
    mockAuthService.validateApiKey.mockResolvedValue(null);
    const ctx = createMockExecutionContext(
      'Bearer hrld_live_revokedkey1234567890123456',
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});

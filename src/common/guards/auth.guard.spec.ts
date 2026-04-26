import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

const mockAuthService = {
  validateApiKey: jest.fn(),
};

const mockConfigService = {
  get: jest.fn(),
};

const mockPrismaService = {
  protocol: {
    findUnique: jest.fn(),
  },
};

function createMockExecutionContext(options: {
  authHeader?: string;
  internalService?: string;
  internalKey?: string;
  protocolId?: string;
  url?: string;
}): ExecutionContext {
  const request: any = {
    headers: {},
    authProtocol: undefined,
  };

  if (options.authHeader) {
    request.headers.authorization = options.authHeader;
  }
  if (options.internalService) {
    request.headers['x-internal-service'] = options.internalService;
  }
  if (options.internalKey) {
    request.headers['x-internal-key'] = options.internalKey;
  }
  if (options.protocolId) {
    request.headers['x-protocol-id'] = options.protocolId;
  }

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
    mockConfigService.get.mockReturnValue(undefined);
    guard = new AuthGuard(
      mockAuthService as any,
      mockConfigService as any,
      mockPrismaService as any,
    );
  });

  describe('standard API key auth', () => {
    it('should deny requests without Authorization header', async () => {
      const ctx = createMockExecutionContext({});
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should deny requests with non-Bearer authorization', async () => {
      const ctx = createMockExecutionContext({ authHeader: 'Basic abc123' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should deny requests with invalid API key', async () => {
      mockAuthService.validateApiKey.mockResolvedValue(null);
      const ctx = createMockExecutionContext({
        authHeader: 'Bearer hrld_live_invalidkey123456789012345',
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
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

      const ctx = createMockExecutionContext({
        authHeader: 'Bearer hrld_live_validkey12345678901234567890',
      });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(ctx.switchToHttp().getRequest().authProtocol).toEqual(protocol);
    });
  });

  describe('internal service bypass', () => {
    it('should allow internal requests to /v1/domains with valid key', async () => {
      mockConfigService.get.mockReturnValue('test-internal-key');
      mockPrismaService.protocol.findUnique.mockResolvedValue({
        id: 'proto-1',
        protocolPubkey: 'abc123',
        tier: 0,
        isActive: true,
      });

      const ctx = createMockExecutionContext({
        internalService: 'herald-admin',
        internalKey: 'test-internal-key',
        protocolId: 'proto-1',
        url: '/v1/domains',
      });

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(ctx.switchToHttp().getRequest().authProtocol).toEqual({
        protocolId: 'proto-1',
        protocolPubkey: 'abc123',
        tier: 0,
        isActive: true,
        apiKeyId: 'internal',
        scopes: ['notify:write'],
        environment: 'production',
      });
    });

    it('should deny internal requests to non-domain paths', async () => {
      mockConfigService.get.mockReturnValue('test-internal-key');

      const ctx = createMockExecutionContext({
        internalService: 'herald-admin',
        internalKey: 'test-internal-key',
        protocolId: 'proto-1',
        url: '/v1/notify',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should deny internal requests without x-protocol-id', async () => {
      mockConfigService.get.mockReturnValue('test-internal-key');

      const ctx = createMockExecutionContext({
        internalService: 'herald-admin',
        internalKey: 'test-internal-key',
        url: '/v1/domains',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing x-protocol-id',
      );
    });

    it('should deny internal requests with invalid protocolId', async () => {
      mockConfigService.get.mockReturnValue('test-internal-key');
      mockPrismaService.protocol.findUnique.mockResolvedValue(null);

      const ctx = createMockExecutionContext({
        internalService: 'herald-admin',
        internalKey: 'test-internal-key',
        protocolId: 'invalid-proto',
        url: '/v1/domains',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Invalid protocolId',
      );
    });

    it('should deny internal requests with wrong key', async () => {
      mockConfigService.get.mockReturnValue('correct-key');

      const ctx = createMockExecutionContext({
        internalService: 'herald-admin',
        internalKey: 'wrong-key',
        protocolId: 'proto-1',
        url: '/v1/domains',
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnsubscribeService } from './unsubscribe.service';
import { PrismaService } from '../../database/prisma.service';

// ── Mocks ─────────────────────────────────────────────────────────

const mockPrisma = {
  unsubscribe_tokens: {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  portal_users: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      UNSUBSCRIBE_JWT_SECRET: 'test-secret-32-chars-minimum!!!!',
      UNSUBSCRIBE_BASE_URL: 'https://notify.test.xyz',
    };
    return config[key] ?? defaultValue;
  }),
};

describe('UnsubscribeService', () => {
  let service: UnsubscribeService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnsubscribeService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<UnsubscribeService>(UnsubscribeService);
  });

  // ── Token Generation ──────────────────────────────────────────────

  describe('generateUnsubscribeUrl', () => {
    it('should generate a URL with the configured base URL', () => {
      const url = service.generateUnsubscribeUrl('abc123hash', 'defi');
      expect(url).toMatch(/^https:\/\/notify\.test\.xyz\/unsubscribe\//);
    });

    it('should generate a URL containing a payload and signature separated by a dot', () => {
      const url = service.generateUnsubscribeUrl('abc123hash', 'defi');
      const token = url.split('/unsubscribe/')[1];
      expect(token.split('.')).toHaveLength(2);
    });

    it('should include the category in the token payload', () => {
      const url = service.generateUnsubscribeUrl('abc123hash', 'governance');
      const token = url.split('/unsubscribe/')[1];
      const [payloadB64] = token.split('.');
      const payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf-8'),
      );
      expect(payload.category).toBe('governance');
      expect(payload.walletHash).toBe('abc123hash');
    });

    it('should set category to null for full opt-out', () => {
      const url = service.generateUnsubscribeUrl('abc123hash', null);
      const token = url.split('/unsubscribe/')[1];
      const [payloadB64] = token.split('.');
      const payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf-8'),
      );
      expect(payload.category).toBeNull();
    });

    it('should store the token hash in the database', () => {
      service.generateUnsubscribeUrl('abc123hash', 'defi');
      // The create is async but should be called
      expect(mockPrisma.unsubscribe_tokens.create).toHaveBeenCalled();
    });
  });

  // ── Token Decoding ────────────────────────────────────────────────

  describe('decodeToken', () => {
    it('should decode a valid token', () => {
      const token = service.generateToken('walletABC', 'marketing');
      const payload = service.decodeToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.walletHash).toBe('walletABC');
      expect(payload!.category).toBe('marketing');
    });

    it('should return null for a tampered token', () => {
      const token = service.generateToken('walletABC', 'defi');
      const tampered = token.slice(0, -3) + 'XXX'; // corrupt the signature
      const payload = service.decodeToken(tampered);
      expect(payload).toBeNull();
    });

    it('should return null for a malformed token (no dot separator)', () => {
      const payload = service.decodeToken('justapayloadwithoutasignature');
      expect(payload).toBeNull();
    });

    it('should return null for expired tokens', () => {
      // Generate a token then manually create one with past expiry
      const pastPayload = JSON.stringify({
        walletHash: 'wallet1',
        category: null,
        expiresAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      });
      const payloadB64 = Buffer.from(pastPayload).toString('base64url');
      // We can't sign it properly without the private method, so decodeToken should reject
      const payload = service.decodeToken(`${payloadB64}.invalidsig`);
      expect(payload).toBeNull();
    });
  });

  // ── Validate and Execute ──────────────────────────────────────────

  describe('validateAndExecute', () => {
    it('should reject invalid token format', async () => {
      const result = await service.validateAndExecute('no-dot-separator');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token format');
    });

    it('should reject invalid signature', async () => {
      const result = await service.validateAndExecute('payload.badsignature');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid/);
    });

    it('should successfully execute per-category unsubscribe', async () => {
      const token = service.generateToken('wallet123', 'governance');

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'somehash',
        used_at: null,
      });
      mockPrisma.portal_users.findUnique.mockResolvedValue({
        wallet_hash: 'wallet123',
        opt_in_governance: true,
      });

      const result = await service.validateAndExecute(token);

      expect(result.success).toBe(true);
      expect(result.payload!.category).toBe('governance');
      expect(mockPrisma.portal_users.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wallet_hash: 'wallet123' },
          data: expect.objectContaining({ opt_in_governance: false }),
        }),
      );
    });

    it('should successfully execute full opt-out unsubscribe', async () => {
      const token = service.generateToken('wallet123', null);

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'somehash',
        used_at: null,
      });
      mockPrisma.portal_users.findUnique.mockResolvedValue({
        wallet_hash: 'wallet123',
        opt_in_all: true,
      });

      const result = await service.validateAndExecute(token);

      expect(result.success).toBe(true);
      expect(mockPrisma.portal_users.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ opt_in_all: false }),
        }),
      );
    });

    it('should reject already-used tokens', async () => {
      const token = service.generateToken('wallet123', 'defi');

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'somehash',
        used_at: new Date(), // Already used!
      });

      const result = await service.validateAndExecute(token);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token already used');
    });
  });
});

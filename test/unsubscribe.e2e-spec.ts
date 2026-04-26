// Mock PrismaService to prevent Prisma generated client import
jest.mock('../src/database/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => mockPrisma),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { UnsubscribeController } from '../src/modules/notify/unsubscribe.controller';
import { UnsubscribeService } from '../src/modules/notify/unsubscribe.service';
import { PrismaService } from '../src/database/prisma.service';

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
      UNSUBSCRIBE_JWT_SECRET: 'test-e2e-secret-32-chars-minimum!!!!',
      UNSUBSCRIBE_BASE_URL: 'https://notify.test.xyz',
    };
    return config[key] ?? defaultValue;
  }),
};

describe('Unsubscribe E2E', () => {
  let app: INestApplication;
  let unsubscribeService: UnsubscribeService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UnsubscribeController],
      providers: [
        UnsubscribeService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    unsubscribeService = module.get<UnsubscribeService>(UnsubscribeService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── GET /unsubscribe/:token ───────────────────────────────────────

  describe('GET /unsubscribe/:token', () => {
    it('should render confirmation page for valid token', async () => {
      const token = unsubscribeService.generateToken('wallet123', 'governance');

      const response = await request(app.getHttpServer())
        .get(`/unsubscribe/${token}`)
        .expect(200);

      expect(response.text).toContain('Unsubscribe');
      expect(response.text).toContain('governance notifications');
      expect(response.text).toContain('Confirm Unsubscribe');
      expect(response.text).toContain('Herald');
    });

    it('should render confirmation page for full opt-out token', async () => {
      const token = unsubscribeService.generateToken('wallet123', null);

      const response = await request(app.getHttpServer())
        .get(`/unsubscribe/${token}`)
        .expect(200);

      expect(response.text).toContain('all notifications');
    });

    it('should return 400 for invalid token', async () => {
      const response = await request(app.getHttpServer())
        .get('/unsubscribe/invalid.token')
        .expect(400);

      expect(response.text).toContain('Error');
    });

    it('should return 400 for malformed token (no dot)', async () => {
      const response = await request(app.getHttpServer())
        .get('/unsubscribe/nodottoken')
        .expect(400);

      expect(response.text).toContain('Error');
    });
  });

  // ── POST /unsubscribe/:token ──────────────────────────────────────

  describe('POST /unsubscribe/:token', () => {
    it('should execute per-category unsubscribe and render success page', async () => {
      const token = unsubscribeService.generateToken('walletABC', 'defi');

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'hash',
        used_at: null,
      });
      mockPrisma.portal_users.findUnique.mockResolvedValue({
        wallet_hash: 'walletABC',
        opt_in_defi: true,
      });

      const response = await request(app.getHttpServer())
        .post(`/unsubscribe/${token}`)
        .expect(200);

      expect(response.text).toContain('Unsubscribed');
      expect(response.text).toContain('defi notifications');

      // Verify DB was updated
      expect(mockPrisma.portal_users.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wallet_hash: 'walletABC' },
          data: expect.objectContaining({ opt_in_defi: false }),
        }),
      );

      // Verify token was marked as used
      expect(mockPrisma.unsubscribe_tokens.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ used_at: expect.any(Date) }),
        }),
      );
    });

    it('should execute full opt-out and render success page', async () => {
      const token = unsubscribeService.generateToken('walletXYZ', null);

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'hash',
        used_at: null,
      });
      mockPrisma.portal_users.findUnique.mockResolvedValue({
        wallet_hash: 'walletXYZ',
        opt_in_all: true,
      });

      const response = await request(app.getHttpServer())
        .post(`/unsubscribe/${token}`)
        .expect(200);

      expect(response.text).toContain('Unsubscribed');
      expect(response.text).toContain('all notifications');

      expect(mockPrisma.portal_users.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ opt_in_all: false }),
        }),
      );
    });

    it('should return 400 for invalid token on POST', async () => {
      const response = await request(app.getHttpServer())
        .post('/unsubscribe/invalid.token')
        .expect(400);

      expect(response.text).toContain('Error');
    });

    it('should return 400 for already-used token', async () => {
      const token = unsubscribeService.generateToken('wallet123', 'defi');

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'hash',
        used_at: new Date(), // Already used
      });

      const response = await request(app.getHttpServer())
        .post(`/unsubscribe/${token}`)
        .expect(400);

      expect(response.text).toContain('Error');
    });
  });

  // ── RFC 8058 List-Unsubscribe-Post ────────────────────────────────

  describe('RFC 8058 one-click unsubscribe', () => {
    it('should handle POST with List-Unsubscribe=One-Click body', async () => {
      const token = unsubscribeService.generateToken('walletRFC', 'marketing');

      mockPrisma.unsubscribe_tokens.findUnique.mockResolvedValue({
        token_hash: 'hash',
        used_at: null,
      });
      mockPrisma.portal_users.findUnique.mockResolvedValue({
        wallet_hash: 'walletRFC',
        opt_in_marketing: true,
      });

      const response = await request(app.getHttpServer())
        .post(`/unsubscribe/${token}`)
        .send('List-Unsubscribe=One-Click')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);

      expect(response.text).toContain('Unsubscribed');
      expect(mockPrisma.portal_users.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ opt_in_marketing: false }),
        }),
      );
    });
  });
});

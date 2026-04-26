/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookWorker } from './webhook.worker';
import { PrismaService } from '../../database/prisma.service';
import { Job } from 'bullmq';

// Mock axios
jest.mock('axios', () => ({
  default: { post: jest.fn() },
  post: jest.fn(),
}));
import axios from 'axios';
const mockedAxios = jest.mocked(axios);

// ── Mocks ─────────────────────────────────────────────────────────

const mockPrisma = {
  webhook: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  webhookDelivery: {
    create: jest.fn().mockResolvedValue({}),
  },
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    if (key === 'WEBHOOK_AUTO_DISABLE_THRESHOLD') return 10;
    return defaultValue;
  }),
};

const createMockJob = (data: any): Job<any> =>
  ({
    data,
    id: 'job-1',
    attemptsMade: 0,
  }) as any;

describe('WebhookWorker', () => {
  let worker: WebhookWorker;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    worker = module.get<WebhookWorker>(WebhookWorker);
  });

  const baseJobData = {
    webhookId: 'wh-1',
    url: 'https://example.com/webhook',
    secret: 'test-secret-key',
    payload: {
      eventId: 'evt-123',
      eventType: 'notification.delivered',
      timestamp: new Date().toISOString(),
      data: { notificationId: 'n-1' },
    },
  };

  // ── Skip inactive webhooks ────────────────────────────────────────

  describe('inactive webhook handling', () => {
    it('should skip delivery for inactive webhooks', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: false,
        failureCount: 0,
      });

      await worker.process(createMockJob(baseJobData));

      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockPrisma.webhookDelivery.create).not.toHaveBeenCalled();
    });

    it('should skip delivery for deleted webhooks', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue(null);

      await worker.process(createMockJob(baseJobData));

      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  // ── Auto-disable ──────────────────────────────────────────────────

  describe('auto-disable after consecutive failures', () => {
    it('should auto-disable webhook when failureCount >= threshold', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 10, // At threshold
      });

      await worker.process(createMockJob(baseJobData));

      // Should have disabled the webhook
      expect(mockPrisma.webhook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'wh-1' },
          data: { isActive: false },
        }),
      );
      // Should NOT have attempted delivery
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should NOT auto-disable when failureCount is below threshold', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 5, // Below threshold
      });
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await worker.process(createMockJob(baseJobData));

      // Should have attempted delivery
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  // ── Successful delivery ───────────────────────────────────────────

  describe('successful delivery', () => {
    it('should send POST with HMAC signature headers', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 0,
      });
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await worker.process(createMockJob(baseJobData));

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Herald-Signature': expect.any(String),
            'X-Herald-Timestamp': expect.any(String),
            'X-Herald-Event': 'notification.delivered',
            'X-Herald-Delivery': 'evt-123',
          }),
        }),
      );
    });

    it('should reset failureCount on success', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 3,
      });
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await worker.process(createMockJob(baseJobData));

      // Should reset failure count
      expect(mockPrisma.webhook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failureCount: 0 }),
        }),
      );
    });

    it('should record delivery attempt in webhookDelivery', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 0,
      });
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await worker.process(createMockJob(baseJobData));

      expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            webhookId: 'wh-1',
            event: 'notification.delivered',
            httpStatus: 200,
            success: true,
            attempt: 1,
          }),
        }),
      );
    });
  });

  // ── Failed delivery ───────────────────────────────────────────────

  describe('failed delivery', () => {
    it('should increment failureCount on HTTP error', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 2,
      });
      mockedAxios.post.mockRejectedValue({
        response: { status: 500 },
        message: 'Internal Server Error',
      });

      await expect(
        worker.process(createMockJob(baseJobData)),
      ).rejects.toBeTruthy();

      expect(mockPrisma.webhook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            failureCount: { increment: 1 },
          }),
        }),
      );
    });

    it('should record failed delivery attempt', async () => {
      mockPrisma.webhook.findUnique.mockResolvedValue({
        isActive: true,
        failureCount: 0,
      });
      mockedAxios.post.mockRejectedValue({
        response: { status: 502 },
        message: 'Bad Gateway',
      });

      await expect(
        worker.process(createMockJob(baseJobData)),
      ).rejects.toBeTruthy();

      expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            error: 'Bad Gateway',
          }),
        }),
      );
    });
  });
});

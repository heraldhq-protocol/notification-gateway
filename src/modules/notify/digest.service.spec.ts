import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { DigestService } from './digest.service';
import { PrismaService } from '../../database/prisma.service';
import { QueueNames } from '../queue/queue.constants';

// ── Mocks ─────────────────────────────────────────────────────────

const mockPrisma = {
  digestQueue: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({}),
};

describe('DigestService', () => {
  let service: DigestService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigestService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken(QueueNames.DIGEST), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<DigestService>(DigestService);
  });

  // ── Buffer ────────────────────────────────────────────────────────

  describe('bufferForDigest', () => {
    it('should insert a record into digestQueue', async () => {
      await service.bufferForDigest({
        walletHash: 'wallet123abc',
        protocolId: 'proto-1',
        subject: 'Test notification',
        body: 'Hello world',
        category: 'defi',
      });

      expect(mockPrisma.digestQueue.create).toHaveBeenCalledTimes(1);
      const createData = mockPrisma.digestQueue.create.mock.calls[0][0].data;
      expect(createData.walletHash).toBe('wallet123abc');
      expect(createData.protocolId).toBe('proto-1');
      expect(createData.subject).toBe('Test notification');
      expect(createData.category).toBe('defi');
      expect(createData.scheduledFor).toBeInstanceOf(Date);
    });

    it('should use custom scheduledFor if provided', async () => {
      const customDate = new Date('2026-12-01T00:00:00Z');

      await service.bufferForDigest({
        walletHash: 'wallet123abc',
        protocolId: 'proto-1',
        subject: 'Test',
        body: 'body',
        category: 'governance',
        scheduledFor: customDate,
      });

      const createData = mockPrisma.digestQueue.create.mock.calls[0][0].data;
      expect(createData.scheduledFor).toBe(customDate);
    });

    it('should default scheduledFor to the next full hour', async () => {
      const before = new Date();

      await service.bufferForDigest({
        walletHash: 'w1',
        protocolId: 'p1',
        subject: 's1',
        body: 'b1',
        category: 'defi',
      });

      const createData = mockPrisma.digestQueue.create.mock.calls[0][0].data;
      const scheduled = createData.scheduledFor as Date;
      expect(scheduled.getMinutes()).toBe(0);
      expect(scheduled.getSeconds()).toBe(0);
      expect(scheduled.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  // ── Flush ─────────────────────────────────────────────────────────

  describe('flushDueDigests', () => {
    it('should not enqueue jobs when no entries are due', async () => {
      mockPrisma.digestQueue.findMany.mockResolvedValue([]);

      await service.flushDueDigests();

      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should group entries by walletHash and enqueue one job per wallet', async () => {
      mockPrisma.digestQueue.findMany.mockResolvedValue([
        {
          id: 'd1',
          walletHash: 'walletA',
          protocolId: 'p1',
          subject: 'S1',
          category: 'defi',
          queuedAt: new Date(),
        },
        {
          id: 'd2',
          walletHash: 'walletA',
          protocolId: 'p1',
          subject: 'S2',
          category: 'governance',
          queuedAt: new Date(),
        },
        {
          id: 'd3',
          walletHash: 'walletB',
          protocolId: 'p2',
          subject: 'S3',
          category: 'defi',
          queuedAt: new Date(),
        },
      ]);

      await service.flushDueDigests();

      expect(mockQueue.add).toHaveBeenCalledTimes(2); // 2 wallets
      const call1 = mockQueue.add.mock.calls[0];
      const call2 = mockQueue.add.mock.calls[1];

      // First wallet should have 2 entries
      const walletACall = [call1, call2].find(
        (c) => c[1].walletHash === 'walletA',
      );
      expect(walletACall![1].entries).toHaveLength(2);

      // Second wallet should have 1 entry
      const walletBCall = [call1, call2].find(
        (c) => c[1].walletHash === 'walletB',
      );
      expect(walletBCall![1].entries).toHaveLength(1);
    });
  });

  // ── Mark as Sent ──────────────────────────────────────────────────

  describe('markAsSent', () => {
    it('should update entries with sentAt timestamp', async () => {
      await service.markAsSent(['d1', 'd2', 'd3']);

      expect(mockPrisma.digestQueue.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['d1', 'd2', 'd3'] } },
        data: { sentAt: expect.any(Date) },
      });
    });
  });
});

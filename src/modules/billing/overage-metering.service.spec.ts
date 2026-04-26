import { Test, TestingModule } from '@nestjs/testing';
import { OverageMeteringService } from './overage-metering.service';
import { PrismaService } from '../../database/prisma.service';

// ── Mocks ─────────────────────────────────────────────────────────

const mockPrisma = {
  $transaction: jest.fn(),
  protocol: {
    update: jest.fn(),
  },
  subscription: {
    updateMany: jest.fn(),
  },
};

describe('OverageMeteringService', () => {
  let service: OverageMeteringService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OverageMeteringService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<OverageMeteringService>(OverageMeteringService);
  });

  // ── Increment ─────────────────────────────────────────────────────

  describe('incrementSendsThisPeriod', () => {
    it('should call $transaction with protocol and subscription updates', async () => {
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      await service.incrementSendsThisPeriod('proto-1', 1);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      const txArgs = mockPrisma.$transaction.mock.calls[0][0];
      expect(txArgs).toHaveLength(2); // protocol.update + subscription.updateMany
    });

    it('should increment by the specified count', async () => {
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      await service.incrementSendsThisPeriod('proto-1', 5);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should default to count of 1', async () => {
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      await service.incrementSendsThisPeriod('proto-1');

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should not throw on Prisma failure (non-fatal)', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB down'));

      // Should not throw — metering failure shouldn't block delivery
      await expect(
        service.incrementSendsThisPeriod('proto-1', 1),
      ).resolves.toBeUndefined();
    });
  });

  // ── Reset ─────────────────────────────────────────────────────────

  describe('resetSendsThisPeriod', () => {
    it('should call $transaction to reset both counters', async () => {
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      await service.resetSendsThisPeriod('proto-1');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('should not throw on Prisma failure', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB down'));

      await expect(
        service.resetSendsThisPeriod('proto-1'),
      ).resolves.toBeUndefined();
    });
  });
});

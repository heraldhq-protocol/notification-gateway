import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { Payment, Prisma } from '../../../../prisma/generated/prisma/index';

@Injectable()
export class PaymentRepository {
    constructor(private readonly prisma: PrismaService) { }

    async create(data: Prisma.PaymentUncheckedCreateInput): Promise<Payment> {
        return this.prisma.payment.create({ data });
    }

    async findByProtocolId(protocolId: string, skip = 0, take = 50): Promise<[Payment[], number]> {
        return Promise.all([
            this.prisma.payment.findMany({
                where: { protocolId },
                orderBy: { createdAt: 'desc' },
                skip,
                take,
            }),
            this.prisma.payment.count({ where: { protocolId } }),
        ]);
    }
}

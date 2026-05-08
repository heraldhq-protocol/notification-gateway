import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../../database/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { StatusResponseDto } from './dto/status-response.dto';

@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getSystemStatus(): Promise<StatusResponseDto> {
    const services: Record<string, 'ok' | 'error'> = {
      database: 'error',
      redis: 'error',
      email: 'ok',
      webhooks: 'ok',
    };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      services.database = 'ok';
    } catch {
      services.database = 'error';
    }

    try {
      await this.redis.ping();
      services.redis = 'ok';
    } catch {
      services.redis = 'error';
    }

    const allOk = Object.values(services).every((s) => s === 'ok');
    const anyError = Object.values(services).some((s) => s === 'error');

    let overallStatus: 'operational' | 'degraded' | 'major_outage' =
      'operational';
    if (services.database === 'error' || services.redis === 'error') {
      overallStatus = 'major_outage';
    } else if (anyError) {
      overallStatus = 'degraded';
    }

    return {
      overallStatus,
      activeIncidents: 0,
      services,
      lastUpdated: new Date().toISOString(),
    };
  }
}

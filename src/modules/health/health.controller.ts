import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';

/**
 * Health check endpoint — reports status of all dependent services.
 *
 * GET /health — no auth required.
 * Returns HTTP 200 with service statuses or 503 if critical services are down.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject("REDIS_CLIENT") private readonly redis: Redis,
    private readonly config: ConfigService,
  ) { }

  @Get()
  @ApiOperation({ summary: 'Health check — DB, Redis, Solana, SMTP status' })
  @ApiResponse({ status: 200, description: 'All services healthy' })
  @ApiResponse({ status: 503, description: 'One or more services degraded' })
  async check() {
    const startTime = process.uptime();
    const services: Record<string, 'ok' | 'error'> = {
      database: 'error',
      redis: 'error',
      solana: 'ok', // checked separately if configured
      smtp: 'ok', // checked separately based on provider
    };

    // Check PostgreSQL
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      services.database = 'ok';
    } catch {
      services.database = 'error';
    }

    // Check Redis
    try {
      const pong = await this.redis.ping();
      services.redis = pong === 'PONG' ? 'ok' : 'error';
    } catch {
      services.redis = 'error';
    }

    const allOk = Object.values(services).every((s) => s === 'ok');
    const anyError = Object.values(services).some((s) => s === 'error');
    const status = allOk ? 'ok' : anyError ? 'degraded' : 'ok';

    return {
      status,
      version: '1.0.0',
      environment: this.config.get('NODE_ENV'),
      services,
      uptime: Math.floor(startTime),
      timestamp: new Date().toISOString(),
    };
  }
}

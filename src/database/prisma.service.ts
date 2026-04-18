import 'dotenv/config';
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'prisma/generated/prisma';

/**
 * PrismaService wraps the Prisma Client and manages its lifecycle.
 *
 * This service is globally available via PrismaModule and handles:
 * - Connection establishment on module init
 * - Graceful disconnection on module destroy
 * - Query logging in development mode
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = `${process.env.DATABASE_URL}`;

    // Disable SSL for local development to avoid TLS errors if the local DB
    // doesn't support SSL. RDS/Production (hosted) will still use SSL.
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');

    const pool = new Pool({
      connectionString,
      ssl: isLocal
        ? false
        : {
            rejectUnauthorized: false,
          },
    });

    const adapter = new PrismaPg(pool);

    super({
      adapter,
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}

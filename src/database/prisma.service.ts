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
    let connectionString = `${process.env.DATABASE_URL}`;

    // RDS/AWS Secrets Manager sometimes appends sslmode=verify-full which
    // overrides our driver-level rejectUnauthorized: false.
    if (connectionString.includes('sslmode=')) {
      connectionString = connectionString.replace(
        /sslmode=[^&]*/,
        'sslmode=no-verify',
      );
    } else if (
      !connectionString.includes('localhost') &&
      !connectionString.includes('127.0.0.1')
    ) {
      const separator = connectionString.includes('?') ? '&' : '?';
      connectionString += `${separator}sslmode=no-verify`;
    }

    // Disable SSL for local development. RDS/Production will use SSL but
    // skip certificate verification to handle AWS self-signed/internal certs.
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');

    const pool = new Pool({
      connectionString,
      max: 25,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: isLocal
        ? false
        : {
            rejectUnauthorized: false,
            // Bypass hostname verification for internal AWS endpoints
            checkServerIdentity: () => undefined,
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

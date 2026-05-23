import { createHash, randomBytes } from 'crypto';
import {
  Injectable,
  Logger,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../database/prisma.service';
import bs58 from 'bs58';
import { getTierLimits } from '../auth/rate-limit.constants';

export type TestKeyType = 'integration' | 'protocol' | 'full';

export interface SandboxConfig {
  isSandbox: boolean;
  testKeyType: TestKeyType;
  dailyLimit: number;
  remainingToday: number;
  expiresAt: Date | null;
  isExpired: boolean;
}

export interface SandboxValidationResult {
  allowed: boolean;
  isSandbox: boolean;
  testKeyType?: TestKeyType;
  apiKeyId?: string;
  dailyLimit: number;
  remainingToday: number;
  error?: string;
  errorCode?: string;
}

@Injectable()
export class SandboxService {
  private static readonly SANDBOX_PREFIX = 'hrld_test_';
  private static readonly EXPIRATION_DAYS = 14;
  private static readonly IP_KEY_LIMIT_PER_DAY = 5;

  private static readonly DAILY_KEY = 'sandbox:daily:';
  private static readonly IP_DAILY_KEY = 'sandbox:ip_daily:';
  private static readonly PLAYGROUND_DAILY_KEY = 'sandbox:playground:';
  private static readonly PLAYGROUND_DAILY_LIMIT = 25;

  private readonly logger = new Logger(SandboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  isTestKey(plainTextKey: string): boolean {
    return plainTextKey.startsWith(SandboxService.SANDBOX_PREFIX);
  }

  isTestKeyByEnvironment(environment: string): boolean {
    return environment === 'sandbox' || environment === 'test';
  }

  async getSandboxConfig(apiKeyId: string): Promise<SandboxConfig | null> {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: {
        isTestKey: true,
        testKeyType: true,
        testDailyLimit: true,
        testNotificationsSent: true,
        expiresAt: true,
      },
    });

    if (!apiKey?.isTestKey) return null;

    const today = await this.getTodayCount(apiKeyId);
    const remaining = Math.max(0, apiKey.testDailyLimit - today);

    return {
      isSandbox: true,
      testKeyType: (apiKey.testKeyType as TestKeyType) || 'integration',
      dailyLimit: apiKey.testDailyLimit,
      remainingToday: remaining,
      expiresAt: apiKey.expiresAt,
      isExpired: apiKey.expiresAt ? new Date() > apiKey.expiresAt : false,
    };
  }

  async validateSandboxKey(apiKeyId: string): Promise<SandboxValidationResult> {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: {
        id: true,
        isTestKey: true,
        testKeyType: true,
        testDailyLimit: true,
        testNotificationsSent: true,
        expiresAt: true,
        isRevoked: true,
      },
    });

    if (!apiKey) {
      return {
        allowed: false,
        isSandbox: false,
        error: 'API key not found',
        errorCode: 'AUTH_INVALID_KEY',
        dailyLimit: 0,
        remainingToday: 0,
      };
    }

    if (apiKey.isRevoked) {
      return {
        allowed: false,
        isSandbox: true,
        apiKeyId: apiKey.id,
        error: 'API key has been revoked',
        errorCode: 'AUTH_KEY_REVOKED',
        dailyLimit: 0,
        remainingToday: 0,
      };
    }

    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
      return {
        allowed: false,
        isSandbox: true,
        apiKeyId: apiKey.id,
        error: 'Test key has expired',
        errorCode: 'SANDBOX_KEY_EXPIRED',
        dailyLimit: 0,
        remainingToday: 0,
      };
    }

    const today = await this.getTodayCount(apiKeyId);
    const remaining = Math.max(0, apiKey.testDailyLimit - today);

    if (remaining <= 0) {
      return {
        allowed: false,
        isSandbox: true,
        apiKeyId: apiKey.id,
        testKeyType: apiKey.testKeyType as TestKeyType,
        dailyLimit: apiKey.testDailyLimit,
        remainingToday: 0,
        error: `Sandbox daily limit reached (${apiKey.testDailyLimit}/day). Upgrade your plan for a higher limit.`,
        errorCode: 'SANDBOX_LIMIT_EXCEEDED',
      };
    }

    return {
      allowed: true,
      isSandbox: true,
      apiKeyId: apiKey.id,
      testKeyType: apiKey.testKeyType as TestKeyType,
      dailyLimit: apiKey.testDailyLimit,
      remainingToday: remaining,
    };
  }

  async incrementUsage(apiKeyId: string): Promise<void> {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { isTestKey: true },
    });

    if (!apiKey?.isTestKey) return;

    const key = `${SandboxService.DAILY_KEY}${apiKeyId}`;
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const ttl = Math.ceil((midnight.getTime() - now.getTime()) / 1000);

    await this.redis.incr(key);
    await this.redis.expire(key, ttl);
  }

  async createTestKey(
    protocolId: string,
    testKeyType: TestKeyType = 'integration',
    ipHash?: string,
  ): Promise<{ id: string; expiresAt: Date }> {
    if (ipHash) {
      const ipKey = `${SandboxService.IP_DAILY_KEY}${ipHash}`;
      const ipCount = await this.redis.get(ipKey);

      if (
        ipCount &&
        parseInt(ipCount, 10) >= SandboxService.IP_KEY_LIMIT_PER_DAY
      ) {
        throw new BadRequestException({
          error: 'SANDBOX_IP_LIMIT_EXCEEDED',
          message: `Maximum ${SandboxService.IP_KEY_LIMIT_PER_DAY} test keys per IP per day`,
        });
      }

      await this.redis.incr(ipKey);
      await this.redis.expire(ipKey, 86400);
    }

    const protocol = await this.prisma.protocol.findUniqueOrThrow({
      where: { id: protocolId },
      select: { tier: true },
    });
    const dailyLimit = getTierLimits(protocol.tier).sandboxDailyLimit;

    const env = 'sandbox';
    const random = randomBytes(32);
    const suffix = bs58.encode(random);
    const plainText = `hrld_test_${suffix}`;

    const hashKey = createHash('sha256').update(plainText).digest('hex');
    const prefix = plainText.substring(0, 16);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SandboxService.EXPIRATION_DAYS);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        protocolId,
        keyHash: hashKey,
        keyPrefix: prefix,
        environment: env,
        scopes: ['notify:write', 'notify:read'],
        isTestKey: true,
        testKeyType,
        testDailyLimit: dailyLimit,
        expiresAt,
        testKeyIpHash: ipHash || null,
        isRevoked: false,
      },
      select: { id: true },
    });

    return { id: apiKey.id, expiresAt };
  }

  async recordSandboxReceipt(params: {
    apiKeyId: string;
    notificationId?: string;
    walletHash: string;
    subject?: string;
    status?: string;
    devnetTx?: string;
    channel?: string;
  }): Promise<void> {
    await this.prisma.sandboxReceipt.create({
      data: {
        apiKeyId: params.apiKeyId,
        notificationId: params.notificationId,
        walletHash: params.walletHash,
        subject: params.subject,
        status: params.status || 'delivered',
        devnetTx: params.devnetTx,
        channel: params.channel,
        deliveredAt: new Date(),
      },
    });
  }

  async getSandboxReceipts(
    apiKeyId: string,
    limit = 100,
  ): Promise<
    Array<{
      id: string;
      walletHash: string;
      subject: string | null;
      status: string;
      channel: string | null;
      devnetTx: string | null;
      deliveredAt: Date | null;
      createdAt: Date;
    }>
  > {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);

    return this.prisma.sandboxReceipt.findMany({
      where: {
        apiKeyId,
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        walletHash: true,
        subject: true,
        status: true,
        channel: true,
        devnetTx: true,
        deliveredAt: true,
        createdAt: true,
      },
    });
  }

  // ── Playground (dashboard sandbox send) ─────────────────────────────────

  async checkPlaygroundLimit(apiKeyId: string): Promise<{
    allowed: boolean;
    remaining: number;
    dailyLimit: number;
  }> {
    const today = await this.getPlaygroundTodayCount(apiKeyId);
    const remaining = Math.max(
      0,
      SandboxService.PLAYGROUND_DAILY_LIMIT - today,
    );
    return {
      allowed: remaining > 0,
      remaining,
      dailyLimit: SandboxService.PLAYGROUND_DAILY_LIMIT,
    };
  }

  async incrementPlaygroundUsage(apiKeyId: string): Promise<void> {
    const key = `${SandboxService.PLAYGROUND_DAILY_KEY}${apiKeyId}`;
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const ttl = Math.ceil((midnight.getTime() - now.getTime()) / 1000);

    await this.redis.incr(key);
    await this.redis.expire(key, ttl);
  }

  private async getPlaygroundTodayCount(apiKeyId: string): Promise<number> {
    const key = `${SandboxService.PLAYGROUND_DAILY_KEY}${apiKeyId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Runs nightly at 02:00 UTC — deletes sandbox receipts older than 25h.
   * The 25h threshold (not 24h) avoids a race with getSandboxReceipts which
   * queries receipts from the last 24h.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupOldReceipts(): Promise<number> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 25);

    const result = await this.prisma.sandboxReceipt.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Sandbox receipt cleanup: removed ${result.count} records`,
      );
    }

    return result.count;
  }

  private async getTodayCount(apiKeyId: string): Promise<number> {
    const key = `${SandboxService.DAILY_KEY}${apiKeyId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  hashIp(ip: string): string {
    return createHash('sha256').update(ip).digest('hex').substring(0, 64);
  }
}

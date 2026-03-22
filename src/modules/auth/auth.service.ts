import { createHash, randomBytes } from 'crypto';
import { Injectable, UnauthorizedException, Logger, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../database/prisma.service';
import type {
  AuthenticatedProtocol,
  GeneratedApiKey,
} from '../../common/types/protocol.types';
import bs58 from 'bs58';

/**
 * AuthService — API key management and validation.
 *
 * API Key Format: hrld_{environment}_{random_32_bytes_base58}
 *   hrld_live_4xR9mKp2nQwBvTsYjL8dHcFoEa3ZiXuW
 *   hrld_test_7yN1pKq4mSwBvRsXjM9eJcGoFb2AiYuV
 *
 * SEC-006: Keys stored as SHA-256 hash only. Plaintext shown once at creation.
 */
@Injectable()
export class AuthService {
  private static readonly CACHE_TTL_SECONDS = 60;
  private static readonly CACHE_PREFIX = 'auth:key:';

  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) { }

  /**
   * Validates an API key and returns the associated protocol.
   * Flow: hash key → check Redis cache → check PostgreSQL → cache result.
   */
  async validateApiKey(
    plainTextKey: string,
  ): Promise<AuthenticatedProtocol | null> {
    if (!this.isValidKeyFormat(plainTextKey)) return null;

    const keyHash = this.hashKey(plainTextKey);
    const cacheKey = `${AuthService.CACHE_PREFIX}${keyHash}`;

    // 1. Check Redis cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as AuthenticatedProtocol;
      }
    } catch (err) {
      this.logger.warn('Redis cache read failed, falling through to PG', {
        error: (err as Error).message,
      });
    }

    // 2. PostgreSQL lookup
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { keyHash, isRevoked: false },
      include: { protocol: true },
    });

    if (!apiKey || !apiKey.protocol) return null;

    const { protocol } = apiKey;

    if (protocol.isSuspended) {
      throw new UnauthorizedException({
        error: 'AUTH_ACCOUNT_SUSPENDED',
        message: 'Account suspended. Visit app.herald.xyz/billing to resolve.',
      });
    }

    const result: AuthenticatedProtocol = {
      protocolId: protocol.id,
      protocolPubkey: protocol.protocolPubkey,
      tier: protocol.tier,
      scopes: apiKey.scopes,
      environment: apiKey.environment,
      isActive: protocol.isActive,
      sendsThisPeriod: protocol.sendsThisPeriod,
    };

    // 3. Cache for 60s
    try {
      await this.redis.setex(
        cacheKey,
        AuthService.CACHE_TTL_SECONDS,
        JSON.stringify(result, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      );
    } catch {
      // Cache write failure is non-fatal
    }

    // 4. Update last_used_at asynchronously (don't block response)
    this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => { });

    return result;
  }

  /** SHA-256 hash for secure storage. SEC-006 compliance. */
  hashKey(plainTextKey: string): string {
    return createHash('sha256').update(plainTextKey).digest('hex');
  }

  /** Generate a new API key. Returns plaintext ONCE — caller stores hash. */
  generateApiKey(environment: 'production' | 'sandbox'): GeneratedApiKey {
    const env = environment === 'production' ? 'live' : 'test';
    const random = randomBytes(32);
    const suffix = bs58.encode(random);
    const plainText = `hrld_${env}_${suffix}`;

    return {
      plainText,
      hash: this.hashKey(plainText),
      prefix: plainText.substring(0, 16),
    };
  }

  /** Invalidate cached auth for a specific key hash. */
  async invalidateCache(keyHash: string): Promise<void> {
    await this.redis.del(`${AuthService.CACHE_PREFIX}${keyHash}`);
  }

  private isValidKeyFormat(key: string): boolean {
    return /^hrld_(live|test)_[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(key);
  }
}

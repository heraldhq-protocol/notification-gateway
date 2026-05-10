import { Injectable, Logger, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { SolanaService } from '../../solana/solana.service';
import { EnclaveService } from './enclave.service';
import type {
  IdentityAccount,
  DecryptedChannels,
} from '../../common/types/notification.types';

/**
 * RoutingService — resolves wallet pubkeys to identity accounts.
 *
 * Flow:
 *   1. Check Redis cache (5 min TTL)
 *   2. If miss → Solana PDA lookup via SolanaService (Herald SDK)
 *   3. Cache result in Redis
 *   4. For decryption → delegate to EnclaveService (TEE)
 *
 * NOTE: This returns the on-chain IdentityAccount which includes
 * ENCRYPTED channel data. Plaintext is only obtained via TEE.
 */
@Injectable()
export class RoutingService {
  private static readonly PDA_CACHE_TTL_SECONDS = 600; // 10 min — identity accounts change rarely

  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly solanaService: SolanaService,
    private readonly enclaveService: EnclaveService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  /**
   * Resolve a wallet pubkey to its IdentityAccount.
   * Returns null if not registered.
   */
  async resolveIdentity(walletPubkey: string): Promise<IdentityAccount | null> {
    const cacheKey = `pda:identity:${walletPubkey}`;

    // Check Redis cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached === 'NOT_REGISTERED') return null;
      if (cached) {
        const parsed = JSON.parse(cached);
        return this.deserializeCached(parsed);
      }
    } catch {
      // Cache read failure — fall through to Solana
    }

    // Fetch from Solana via Herald SDK
    const identity =
      await this.solanaService.fetchIdentityAccount(walletPubkey);

    if (!identity) {
      await this.redis.setex(cacheKey, 120, 'NOT_REGISTERED').catch(() => {});
      return null;
    }

    // Cache the identity (serialize Uint8Arrays as base64)
    const serializable = this.serializeForCache(identity);
    await this.redis
      .setex(
        cacheKey,
        RoutingService.PDA_CACHE_TTL_SECONDS,
        JSON.stringify(serializable),
      )
      .catch(() => {});

    return identity;
  }

  /**
   * Cache-only identity resolution — never hits Solana RPC.
   * Returns null on cache miss or if wallet is known not registered.
   * Used in the synchronous /v1/notify path to avoid blocking on RPC.
   */
  async resolveIdentityFromCache(
    walletPubkey: string,
  ): Promise<IdentityAccount | null> {
    const cacheKey = `pda:identity:${walletPubkey}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached === 'NOT_REGISTERED') return null;
      if (cached) return this.deserializeCached(JSON.parse(cached));
    } catch {
      // cache miss or read failure
    }
    return null;
  }

  /**
   * Decrypt the encrypted email via TEE enclave (legacy single-channel).
   * Returns plaintext email IN MEMORY ONLY.
   *
   * SEC-001: The caller MUST NOT persist or log the return value.
   */
  async decryptEmailInEnclave(identity: IdentityAccount): Promise<string> {
    return this.enclaveService.decrypt({
      encryptedEmail: identity.encryptedEmail,
      nonce: identity.nonce,
      ownerPubkey: identity.owner,
    });
  }

  /**
   * Decrypt all active channels in a single TEE round-trip.
   * Returns DecryptedChannels with only the active channel identifiers.
   *
   * SEC-001: The caller MUST NOT persist or log ANY return values.
   */
  async decryptAllChannelsInEnclave(
    identity: IdentityAccount,
  ): Promise<DecryptedChannels> {
    return this.enclaveService.decryptAllChannels(identity);
  }

  // ── Cache serialization helpers ─────────────────────────────

  private serializeForCache(identity: IdentityAccount): Record<string, any> {
    return {
      ...identity,
      encryptedEmail: Buffer.from(identity.encryptedEmail).toString('base64'),
      emailHash: Buffer.from(identity.emailHash).toString('base64'),
      nonce: Buffer.from(identity.nonce).toString('base64'),
      encryptedTelegramId: Buffer.from(identity.encryptedTelegramId).toString(
        'base64',
      ),
      telegramIdHash: Buffer.from(identity.telegramIdHash).toString('base64'),
      nonceTelegram: Buffer.from(identity.nonceTelegram).toString('base64'),
      encryptedPhone: Buffer.from(identity.encryptedPhone).toString('base64'),
      phoneHash: Buffer.from(identity.phoneHash).toString('base64'),
      nonceSms: Buffer.from(identity.nonceSms).toString('base64'),
    };
  }

  private deserializeCached(parsed: any): IdentityAccount {
    return {
      ...parsed,
      encryptedEmail: new Uint8Array(
        Buffer.from(parsed.encryptedEmail, 'base64'),
      ),
      emailHash: new Uint8Array(Buffer.from(parsed.emailHash, 'base64')),
      nonce: new Uint8Array(Buffer.from(parsed.nonce, 'base64')),
      encryptedTelegramId: new Uint8Array(
        Buffer.from(parsed.encryptedTelegramId ?? '', 'base64'),
      ),
      telegramIdHash: new Uint8Array(
        Buffer.from(parsed.telegramIdHash ?? '', 'base64'),
      ),
      nonceTelegram: new Uint8Array(
        Buffer.from(parsed.nonceTelegram ?? '', 'base64'),
      ),
      encryptedPhone: new Uint8Array(
        Buffer.from(parsed.encryptedPhone ?? '', 'base64'),
      ),
      phoneHash: new Uint8Array(Buffer.from(parsed.phoneHash ?? '', 'base64')),
      nonceSms: new Uint8Array(Buffer.from(parsed.nonceSms ?? '', 'base64')),
      channelEmail: parsed.channelEmail ?? false,
      channelTelegram: parsed.channelTelegram ?? false,
      channelSms: parsed.channelSms ?? false,
    } as IdentityAccount;
  }
}

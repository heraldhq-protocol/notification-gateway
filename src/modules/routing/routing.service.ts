import { Injectable, Logger, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { SolanaService } from '../../solana/solana.service';
import { EnclaveService } from './enclave.service';
import type { IdentityAccount } from '../../common/types/notification.types';

/**
 * RoutingService — resolves wallet pubkeys to identity accounts.
 *
 * Flow:
 *   1. Check Redis cache (5 min TTL)
 *   2. If miss → Solana PDA lookup via SolanaService (Herald SDK)
 *   3. Cache result in Redis
 *   4. For email decryption → delegate to EnclaveService (TEE)
 *
 * NOTE: This returns the on-chain IdentityAccount which includes
 * the ENCRYPTED email. Plaintext is only obtained via TEE.
 */
@Injectable()
export class RoutingService {
  private static readonly PDA_CACHE_TTL_SECONDS = 300; // 5 minutes

  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly solanaService: SolanaService,
    private readonly enclaveService: EnclaveService,
    @Inject("REDIS_CLIENT") private readonly redis: Redis,
  ) { }

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
      if (cached) return JSON.parse(cached) as IdentityAccount;
    } catch {
      // Cache read failure — fall through to Solana
    }

    // Fetch from Solana via Herald SDK
    const identity =
      await this.solanaService.fetchIdentityAccount(walletPubkey);

    if (!identity) {
      await this.redis.setex(cacheKey, 60, 'NOT_REGISTERED').catch(() => { });
      return null;
    }

    // Cache the identity (serialize Uint8Arrays as base64)
    const serializable = {
      ...identity,
      encryptedEmail: Buffer.from(identity.encryptedEmail).toString('base64'),
      emailHash: Buffer.from(identity.emailHash).toString('base64'),
      nonce: Buffer.from(identity.nonce).toString('base64'),
    };
    await this.redis
      .setex(
        cacheKey,
        RoutingService.PDA_CACHE_TTL_SECONDS,
        JSON.stringify(serializable),
      )
      .catch(() => { });

    return identity;
  }

  /**
   * Decrypt the encrypted email via TEE enclave.
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
}

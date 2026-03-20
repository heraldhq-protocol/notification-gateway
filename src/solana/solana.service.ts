import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { ReadClient } from '@herald-protocol/sdk';
import { findIdentityPda } from '@herald-protocol/sdk/pda';
import { RpcManagerService } from './rpc-manager.service.js';
import { RegistryUnavailableException } from '../common/exceptions/herald.exception.js';
import type { IdentityAccount } from '../common/types/notification.types.js';

/**
 * SolanaService — Solana blockchain interactions.
 *
 * Uses the Herald Protocol SDK's ReadClient for PDA lookups
 * and account deserialization. Wraps the RPC manager for
 * automatic failover.
 */
@Injectable()
export class SolanaService {
  private readClient: ReadClient;
  private readonly logger = new Logger(SolanaService.name);

  constructor(
    private readonly rpcManager: RpcManagerService,
    private readonly config: ConfigService,
  ) {
    this.readClient = new ReadClient({
      rpcUrl: this.rpcManager.getConnection().rpcEndpoint,
      programId: this.config.get<string>('HERALD_PROGRAM_ID'),
      commitment: 'confirmed',
    });
  }

  /**
   * Fetch a Herald IdentityAccount from the on-chain registry.
   * Returns null if the wallet has no identity PDA.
   */
  async fetchIdentityAccount(
    walletPubkey: string,
  ): Promise<IdentityAccount | null> {
    try {
      const connection = this.rpcManager.getConnection();

      // Use the SDK's ReadClient for proper deserialization
      const identity = await this.readClient.fetchIdentityAccount(
        new PublicKey(walletPubkey),
      );
      this.rpcManager.recordSuccess();

      if (!identity) return null;

      return {
        owner: identity.owner.toString(),
        encryptedEmail: new Uint8Array(identity.encryptedEmail),
        emailHash: new Uint8Array(identity.emailHash),
        nonce: new Uint8Array(identity.nonce),
        registeredAt: Number(identity.registeredAt),
        optInAll: identity.optInAll,
        optInDefi: identity.optInDefi,
        optInGovernance: identity.optInGovernance,
        optInMarketing: identity.optInMarketing,
        digestMode: identity.digestMode ?? false,
      };
    } catch (err) {
      this.rpcManager.recordFailure();
      this.logger.error('Failed to fetch identity PDA', {
        wallet: walletPubkey.slice(0, 8) + '...',
        error: (err as Error).message,
      });
      throw new RegistryUnavailableException();
    }
  }

  /**
   * Derive Herald identity PDA address (without RPC call).
   * Uses the SDK's findIdentityPda utility.
   */
  deriveIdentityPda(walletPubkey: string): PublicKey {
    const programId = new PublicKey(
      this.config.get<string>('HERALD_PROGRAM_ID') ??
        '2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf',
    );
    const [pda] = findIdentityPda(new PublicKey(walletPubkey), programId);
    return pda;
  }
}

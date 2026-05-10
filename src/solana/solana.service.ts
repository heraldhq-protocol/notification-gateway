import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { ReadClient } from '@herald-protocol/sdk';
import { findIdentityPda } from '@herald-protocol/sdk/pda';
import { RpcManagerService } from './rpc-manager.service';
import { RegistryUnavailableException } from '../common/exceptions/herald.exception';
import type { IdentityAccount } from '../common/types/notification.types';

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

  private static readonly RPC_TIMEOUT_MS = 10_000;

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
   *
   * Wraps the SDK call in a timeout to prevent hung requests
   * when the RPC endpoint is unreachable (NF-001, NF-008).
   */
  async fetchIdentityAccount(
    walletPubkey: string,
  ): Promise<IdentityAccount | null> {
    try {
      // SDK's ReadClient uses @solana/web3.js Connection internally.
      // We cannot control its fetch config, so we enforce a timeout
      // via Promise.race as a safety net.
      const identity = await this.withTimeout(
        this.readClient.fetchIdentityAccount(new PublicKey(walletPubkey)),
        SolanaService.RPC_TIMEOUT_MS,
        'fetchIdentityAccount',
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
        // Channel flags
        channelEmail: identity.channelEmail ?? true,
        channelTelegram: identity.channelTelegram ?? false,
        channelSms: identity.channelSms ?? false,
        // Telegram channel
        encryptedTelegramId: new Uint8Array(identity.encryptedTelegramId ?? []),
        telegramIdHash: new Uint8Array(identity.telegramIdHash ?? []),
        nonceTelegram: new Uint8Array(identity.nonceTelegram ?? []),
        // SMS channel
        encryptedPhone: new Uint8Array(identity.encryptedPhone ?? []),
        phoneHash: new Uint8Array(identity.phoneHash ?? []),
        nonceSms: new Uint8Array(identity.nonceSms ?? []),
        // Notification key
        // Cast to any since the installed SDK may not yet include these fields
        sealedX25519Pubkey: new Uint8Array(
          (identity as any).sealedX25519Pubkey ?? [],
        ),
        senderX25519Pubkey: new Uint8Array(
          (identity as any).senderX25519Pubkey ?? [],
        ),
        notificationNonce: new Uint8Array(
          (identity as any).notificationNonce ?? [],
        ),
        notificationKeyVersion: (identity as any).notificationKeyVersion ?? 0,
        notificationKeyUpdatedAt: Number(
          (identity as any).notificationKeyUpdatedAt ?? 0,
        ),
        notificationKeyRotationCount:
          (identity as any).notificationKeyRotationCount ?? 0,
      };
    } catch (err) {
      this.rpcManager.recordFailure();
      const rpcUrl = this.config.get<string>('SOLANA_RPC_URL');
      const maskedUrl = rpcUrl ? rpcUrl.replace(/\?.*/, '/***') : 'unknown';
      this.logger.error('Failed to fetch identity PDA', {
        wallet: walletPubkey.slice(0, 8) + '...',
        rpcUrl: maskedUrl,
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

  async sendAndConfirm(
    instructions: TransactionInstruction[],
    signers: Keypair[],
  ): Promise<string> {
    const connection = this.rpcManager.getConnection();
    const { blockhash, lastValidBlockHeight } = await this.withTimeout(
      connection.getLatestBlockhash('confirmed'),
      SolanaService.RPC_TIMEOUT_MS,
      'getLatestBlockhash',
    );
    const tx = new Transaction({
      feePayer: signers[0].publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(...instructions);
    return sendAndConfirmTransaction(connection, tx, signers, {
      commitment: 'confirmed',
    });
  }

  /**
   * Fetch ALL registered Herald identity accounts.
   * WARNING: This uses getProgramAccounts which can be expensive.
   * Should only be used for platform-wide broadcasts by Herald Admin.
   */
  async fetchAllIdentities(): Promise<string[]> {
    try {
      const connection = this.rpcManager.getConnection();
      const programId = new PublicKey(
        this.config.get<string>('HERALD_PROGRAM_ID') ??
          '2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf',
      );

      // Anchor discriminator for "identityAccount"
      const discriminator = Buffer.from([
        194, 90, 181, 160, 182, 206, 116, 158,
      ]);

      const accounts = await this.withTimeout(
        connection.getProgramAccounts(programId, {
          commitment: 'confirmed',
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: discriminator.toString('base64'),
                encoding: 'base64',
              },
            },
          ],
          // Only fetch the owner field (offset 8, size 32) + discriminator
          // But getProgramAccounts typically returns full data or just pubkey
          dataSlice: { offset: 8, length: 32 },
        }),
        SolanaService.RPC_TIMEOUT_MS,
        'getProgramAccounts',
      );

      this.rpcManager.recordSuccess();

      // Deserialise the owner pubkey from the data slice
      return accounts.map((a) => new PublicKey(a.account.data).toBase58());
    } catch (err) {
      this.rpcManager.recordFailure();
      this.logger.error('Failed to fetch all identities', {
        error: (err as Error).message,
      });
      throw new RegistryUnavailableException();
    }
  }

  /**
   * Enforce a timeout on any promise. If the promise does not settle within
   * `ms` milliseconds, rejects with a descriptive TimeoutError.
   *
   * Used as a safety net when calling external systems (Solana RPC, etc.)
   * that may hang indefinitely (NF-001, NF-008).
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[${label}] RPC timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}

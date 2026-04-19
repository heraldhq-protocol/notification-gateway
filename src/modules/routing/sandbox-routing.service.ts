import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { ReadClient } from '@herald-protocol/sdk';
import { findIdentityPda } from '@herald-protocol/sdk/pda';
import { SandboxService } from '../sandbox/sandbox.service';
import { EnclaveService } from './enclave.service';
import type { IdentityAccount } from '../../common/types/notification.types';
import type { DecryptedChannels } from '../../common/types/notification.types';

export interface SandboxRoutingConfig {
  useDevnet: boolean;
  rpcUrl: string;
  addTestPrefix: boolean;
}

export interface DevnetResolutionResult {
  /** Whether the wallet was found and decrypted from devnet */
  resolved: boolean;
  channels: DecryptedChannels;
  /** The raw on-chain identity (for opt-in checks) */
  identity: IdentityAccount | null;
}

/**
 * SandboxRoutingService — devnet PDA resolution + sandbox receipt recording.
 *
 * Sandbox notification delivery precedence:
 *   1. Devnet wallet resolution (wallet registered on devnet, channels decrypted
 *      via ENCLAVE_TEST_KEY secretbox) — real end-to-end test.
 *   2. Protocol's static test contacts (test_email / test_telegram_id in
 *      protocol_settings) — fallback when wallet not on devnet.
 *
 * The devnet ReadClient uses SOLANA_DEVNET_RPC_URL and HERALD_DEVNET_PROGRAM_ID.
 * These should be set in .env even in production so sandbox keys always target devnet.
 */
@Injectable()
export class SandboxRoutingService {
  private readonly logger = new Logger(SandboxRoutingService.name);
  private devnetClient: ReadClient | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly sandboxService: SandboxService,
    private readonly enclaveService: EnclaveService,
  ) {
    this.initDevnetClient();
  }

  // ── Devnet client ───────────────────────────────────────────────────────────

  private initDevnetClient(): void {
    const rpcUrl =
      this.config.get<string>('SOLANA_DEVNET_RPC_URL') ??
      'https://api.devnet.solana.com';
    const programId =
      this.config.get<string>('HERALD_DEVNET_PROGRAM_ID') ??
      this.config.get<string>('HERALD_PROGRAM_ID');

    if (!programId) {
      this.logger.warn(
        'HERALD_DEVNET_PROGRAM_ID not set — devnet resolution disabled for sandbox',
      );
      return;
    }

    try {
      this.devnetClient = new ReadClient({
        rpcUrl,
        programId,
        commitment: 'confirmed',
      });
      this.logger.log('Devnet ReadClient initialised', {
        rpcUrl,
        programId: programId.slice(0, 8) + '...',
      });
    } catch (err) {
      this.logger.error('Failed to initialise devnet ReadClient', {
        error: (err as Error).message,
      });
    }
  }

  getSandboxConfig(): SandboxRoutingConfig {
    return {
      useDevnet: this.devnetClient !== null,
      rpcUrl:
        this.config.get<string>('SOLANA_DEVNET_RPC_URL') ??
        'https://api.devnet.solana.com',
      addTestPrefix: true,
    };
  }

  /**
   * Prepend [HERALD TEST] to a notification subject.
   * Applied universally — no bypass for any key type.
   */
  addTestPrefix(subject: string): string {
    return `[HERALD TEST] ${subject}`;
  }

  // ── Devnet wallet resolution ────────────────────────────────────────────────

  /**
   * Try to resolve the wallet's identity from the devnet program registry
   * and decrypt its channels using ENCLAVE_TEST_KEY (nacl.secretbox).
   *
   * Returns resolved=false if:
   *   - Devnet client is not initialised
   *   - Wallet has no identity PDA on devnet
   *   - Decryption fails (wrong key, wrong encryption scheme)
   *
   * This is the "sandbox enclave" — real encryption/decryption without Nitro.
   * The portal encrypts in devnet mode using nacl.secretbox + ENCLAVE_TEST_KEY.
   * The gateway decrypts the same way here.
   */
  async resolveDevnetWallet(
    walletPubkey: string,
  ): Promise<DevnetResolutionResult> {
    if (!this.devnetClient) {
      return { resolved: false, channels: {}, identity: null };
    }

    try {
      const identity = await this.devnetClient.fetchIdentityAccount(
        new PublicKey(walletPubkey),
      );

      if (!identity) {
        this.logger.debug('Wallet not registered on devnet', {
          wallet: walletPubkey.slice(0, 8),
        });
        return { resolved: false, channels: {}, identity: null };
      }

      const identityAccount: IdentityAccount = {
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
        channelEmail: identity.channelEmail ?? true,
        channelTelegram: identity.channelTelegram ?? false,
        channelSms: identity.channelSms ?? false,
        encryptedTelegramId: new Uint8Array(identity.encryptedTelegramId ?? []),
        telegramIdHash: new Uint8Array(identity.telegramIdHash ?? []),
        nonceTelegram: new Uint8Array(identity.nonceTelegram ?? []),
        encryptedPhone: new Uint8Array(identity.encryptedPhone ?? []),
        phoneHash: new Uint8Array(identity.phoneHash ?? []),
        nonceSms: new Uint8Array(identity.nonceSms ?? []),
      };

      // Decrypt channels using ENCLAVE_TEST_KEY (sandbox secretbox mode).
      // EnclaveService.decryptAllChannels() automatically uses secretbox when
      // NODE_ENV=development or ENCLAVE_MODE=sandbox.
      const channels =
        await this.enclaveService.decryptAllChannels(identityAccount);

      const hasAnyChannel =
        !!channels.email || !!channels.telegramChatId || !!channels.phone;

      if (!hasAnyChannel) {
        this.logger.debug(
          'Devnet identity found but no channels decrypted (ENCLAVE_TEST_KEY mismatch?)',
          { wallet: walletPubkey.slice(0, 8) },
        );
        // Return the identity so the caller can still check opt-in flags,
        // but resolved=false so it falls back to test contacts for delivery.
        return { resolved: false, channels, identity: identityAccount };
      }

      this.logger.log('Devnet wallet resolved for sandbox delivery', {
        wallet: walletPubkey.slice(0, 8),
        channels: Object.keys(channels).filter((k) => !!(channels as any)[k]),
      });

      return { resolved: true, channels, identity: identityAccount };
    } catch (err) {
      this.logger.warn(
        'Devnet resolution failed, falling back to test contacts',
        {
          wallet: walletPubkey.slice(0, 8),
          error: (err as Error).message,
        },
      );
      return { resolved: false, channels: {}, identity: null };
    }
  }

  // ── Devnet receipt recording ────────────────────────────────────────────────

  /**
   * Record a devnet transaction receipt for a sandbox notification.
   */
  async recordDevnetTransaction(
    apiKeyId: string,
    walletHash: string,
    txSignature: string,
    channel?: string,
  ): Promise<void> {
    await this.sandboxService.recordSandboxReceipt({
      apiKeyId,
      walletHash,
      status: 'delivered',
      devnetTx: txSignature,
      channel: channel ?? 'devnet',
    });

    this.logger.log('Recorded devnet transaction for sandbox', {
      apiKeyId,
      walletHash: walletHash.slice(0, 8),
      txSignature: txSignature.slice(0, 8),
    });
  }

  /**
   * Derive the devnet identity PDA address without an RPC call.
   */
  deriveDevnetPda(walletPubkey: string): string | null {
    const programId =
      this.config.get<string>('HERALD_DEVNET_PROGRAM_ID') ??
      this.config.get<string>('HERALD_PROGRAM_ID');
    if (!programId) return null;

    try {
      const [pda] = findIdentityPda(
        new PublicKey(walletPubkey),
        new PublicKey(programId),
      );
      return pda.toBase58();
    } catch {
      return null;
    }
  }
}

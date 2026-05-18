import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Rpc, createRpc } from '@lightprotocol/stateless.js';
import { fetchProofForReceipt } from '@herald-protocol/sdk/light';
import type { LightProofResponse } from '@herald-protocol/sdk';
import { HERALD_PROGRAM_ID } from '@herald-protocol/sdk';

/**
 * Known Solana genesis hashes for cluster detection.
 * Used to determine whether we're on localnet, devnet, or mainnet
 * for receipt-writing configuration.
 */
const GENESIS_HASHES = {
  // solana-test-validator / light-test-validator
  LOCAL: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  // Solana devnet
  DEVNET: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcg9N2iv2Dr7',
  // Solana mainnet-beta
  MAINNET: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

@Injectable()
export class LightClientService implements OnModuleInit {
  private readonly logger = new Logger(LightClientService.name);
  private readonly lightRpc: Rpc;
  private readonly solanaRpcUrl: string;
  private readonly photonRpcUrl: string;

  constructor(private readonly config: ConfigService) {
    this.solanaRpcUrl =
      this.config.get<string>('SOLANA_RPC_URL') || 'http://localhost:8899';
    this.photonRpcUrl =
      this.config.get<string>('LIGHT_RPC_URL') || this.solanaRpcUrl;

    // createRpc in stateless.js v0.23.x accepts a single Helius endpoint
    // that supports both Solana RPC and Photon compression methods.
    this.lightRpc = createRpc(this.solanaRpcUrl, this.photonRpcUrl);
  }

  /**
   * Startup validation — log connectivity info for debugging.
   */
  async onModuleInit() {
    try {
      const cluster = await this.getClusterType();
      this.logger.log(
        `Light Protocol client initialized (V2) — cluster: ${cluster}, Solana RPC: ${this.solanaRpcUrl}, Photon RPC: ${this.photonRpcUrl}`,
      );
    } catch (e) {
      this.logger.warn(
        `Light Protocol client init warning: ${(e as Error).message}. Receipt writing may fail.`,
      );
    }
  }

  /**
   * Fetches a ValidityProof for writing a new delivery receipt.
   *
   * Uses the ZK Compression V2 API:
   *   - Derives a unique compressed-account address from notificationId + recipientHash
   *   - Calls getValidityProofV0 to prove non-existence of the new address
   *   - Packs Light System accounts + address tree + output state tree
   *
   * @param notificationId  UUID v4 as 16 bytes
   * @param recipientHash   SHA-256 of the recipient wallet pubkey (32 bytes)
   */
  async getValidityProof(
    notificationId: Uint8Array,
    recipientHash: Uint8Array,
  ): Promise<LightProofResponse> {
    try {
      return await fetchProofForReceipt(
        this.lightRpc,
        notificationId,
        recipientHash,
        HERALD_PROGRAM_ID,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to get ValidityProof from ${this.photonRpcUrl}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Detect the Solana cluster by comparing the genesis hash.
   * Returns 'local', 'devnet', or 'mainnet'.
   */
  async getClusterType(): Promise<'local' | 'devnet' | 'mainnet'> {
    try {
      const genesis = await this.lightRpc.getGenesisHash();

      if (genesis === GENESIS_HASHES.LOCAL) return 'local';
      if (genesis === GENESIS_HASHES.DEVNET) return 'devnet';
      if (genesis === GENESIS_HASHES.MAINNET) return 'mainnet';

      this.logger.warn(
        `Unknown genesis hash: ${genesis}. Defaulting to 'devnet' behavior.`,
      );
      return 'devnet';
    } catch (e) {
      this.logger.warn(`Failed to get genesis hash: ${(e as Error).message}`);
      if (
        this.solanaRpcUrl.includes('localhost') ||
        this.solanaRpcUrl.includes('127.0.0.1')
      ) {
        return 'local';
      }
      if (this.solanaRpcUrl.includes('devnet')) {
        return 'devnet';
      }
      return 'mainnet';
    }
  }

  /**
   * Get the underlying Light RPC connection for direct use.
   */
  getRpc(): Rpc {
    return this.lightRpc;
  }
}

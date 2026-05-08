import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { Rpc, createRpc } from '@lightprotocol/stateless.js';
import { fetchProofForReceipt, type LightProofResponse } from '@herald-protocol/sdk';

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

    this.lightRpc = createRpc(this.solanaRpcUrl, this.photonRpcUrl);
  }

  /**
   * Startup validation — log connectivity info for debugging.
   */
  async onModuleInit() {
    try {
      const cluster = await this.getClusterType();
      this.logger.log(
        `Light Protocol client initialized — cluster: ${cluster}, Solana RPC: ${this.solanaRpcUrl}, Photon RPC: ${this.photonRpcUrl}`,
      );
    } catch (e) {
      this.logger.warn(
        `Light Protocol client init warning: ${(e as Error).message}. Receipt writing may fail.`,
      );
    }
  }

  /**
   * Fetches a ValidityProof via the SDK's fetchProofForReceipt helper.
   * Calls Light RPC getValidityProof with the output tree address,
   * returning proof, outputTreeIndex, and remainingAccounts for CPI.
   * Works for both local test-validator and devnet/mainnet.
   */
  async getValidityProof(
    outputTreeAddress: PublicKey | string,
  ): Promise<LightProofResponse> {
    const treeAddress =
      typeof outputTreeAddress === 'string'
        ? new PublicKey(outputTreeAddress)
        : outputTreeAddress;

    try {
      return await fetchProofForReceipt(this.lightRpc, treeAddress);
    } catch (error) {
      this.logger.error(
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

      // Unknown genesis hash — could be a custom validator
      this.logger.warn(
        `Unknown genesis hash: ${genesis}. Defaulting to 'devnet' behavior.`,
      );
      return 'devnet';
    } catch (e) {
      this.logger.warn(`Failed to get genesis hash: ${(e as Error).message}`);
      // If RPC is unreachable, check URL heuristics
      if (
        this.solanaRpcUrl.includes('localhost') ||
        this.solanaRpcUrl.includes('127.0.0.1')
      ) {
        return 'local';
      }
      if (this.solanaRpcUrl.includes('devnet')) {
        return 'devnet';
      }
      return 'mainnet'; // Conservative default for production safety
    }
  }

  /**
   * Get the underlying Light RPC connection for direct use.
   */
  getRpc(): Rpc {
    return this.lightRpc;
  }
}

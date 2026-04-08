import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { Rpc, createRpc } from '@lightprotocol/stateless.js';

export interface LightProofResponse {
  compressedProof: any;
  outputTreeIndex: number;
  remainingAccounts: any[];
  merkleTrees: string[];
}

@Injectable()
export class LightClientService {
  private readonly logger = new Logger(LightClientService.name);
  private readonly lightRpc: Rpc;

  constructor(private readonly config: ConfigService) {
    const solanaRpc =
      this.config.get<string>('SOLANA_RPC_URL') || 'http://localhost:8899';
    const photonRpc = this.config.get<string>('LIGHT_RPC_URL') || solanaRpc;

    this.lightRpc = createRpc(solanaRpc, photonRpc);
  }

  /**
   * Fetches a ValidityProof using Light Protocol's official SDK.
   * Works for both local test-validator and devnet.
   */
  async getValidityProof(
    outputTreeAddress: PublicKey | string,
  ): Promise<LightProofResponse> {
    const treeAddress =
      typeof outputTreeAddress === 'string'
        ? new PublicKey(outputTreeAddress)
        : outputTreeAddress;

    try {
      const proof = await this.lightRpc.getValidityProofV0([], []);

      const p = proof as any;
      return {
        compressedProof: p.compressedProof,
        outputTreeIndex: p.rootIndices?.[0] || 0,
        remainingAccounts: p.remainingAccounts || [],
        merkleTrees: p.merkleTrees || [treeAddress.toBase58()],
      };
    } catch (error) {
      this.logger.error(
        `Failed to get ValidityProof from ${this.config.get(
          'LIGHT_RPC_URL',
        )}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async getClusterType(): Promise<'local' | 'devnet' | 'mainnet'> {
    try {
      const genesis = await this.lightRpc.getGenesisHash();
      if (genesis === '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY')
        return 'local';
      if (genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1') return 'devnet';
      return 'mainnet';
    } catch (e) {
      this.logger.warn(`Failed to get genesis hash: ${(e as Error).message}`);
      return 'local'; // default to local if RPC fails for some reason
    }
  }
}

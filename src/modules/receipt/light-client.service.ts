import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PublicKey } from '@solana/web3.js';

export interface LightProofResponse {
  compressedProof: any;
  outputTreeIndex: number;
  remainingAccounts: any[];
}

@Injectable()
export class LightClientService {
  private readonly logger = new Logger(LightClientService.name);
  private readonly rpcUrl: string;

  constructor(private readonly config: ConfigService) {
    this.rpcUrl =
      this.config.get<string>('LIGHT_RPC_URL') || 'http://localhost:8899';
  }

  /**
   * Fetches a ValidityProof from the Light RPC for ZK compression.
   */
  async getValidityProof(
    outputTreeAddress: PublicKey | string,
  ): Promise<LightProofResponse> {
    const treeAddressStr =
      typeof outputTreeAddress === 'string'
        ? outputTreeAddress
        : outputTreeAddress.toBase58();

    try {
      const response = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getValidityProof',
        params: [
          [], // No input compressed accounts
          [{ merkleTree: treeAddressStr }],
        ],
      });

      if (response.data.error) {
        throw new Error(response.data.error.message);
      }

      return response.data.result as LightProofResponse;
    } catch (error) {
      this.logger.error(
        `Failed to get ValidityProof from Light RPC: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}

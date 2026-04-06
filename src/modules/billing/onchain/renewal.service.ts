import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { PublicKey, Keypair } from '@solana/web3.js';
import * as fs from 'fs/promises';
import { SolanaService } from 'src/solana/solana.service';

@Injectable()
export class OnChainRenewalService {
  constructor(
    private readonly solanaService: SolanaService,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {}

  async renewSubscription(protocolOwner: PublicKey): Promise<string> {
    const authorityKeypair = await this.getAuthorityKeypair();
    const { AuthorityClient } = await import('@herald-protocol/sdk/authority');

    const authorityClient = new AuthorityClient({
      rpcUrl: this.config.getOrThrow<string>('SOLANA_RPC_URL'),
      cluster:
        this.config.get<string>('NODE_ENV') === 'production'
          ? 'mainnet-beta'
          : 'devnet',
    });

    const ix = await authorityClient.renewSubscription({
      authority: authorityKeypair.publicKey,
      protocolOwner,
    });

    return this.solanaService.sendAndConfirm([ix], [authorityKeypair]);
  }

  async resetProtocolSends(protocolPubkey: string): Promise<string> {
    const authorityKeypair = await this.getAuthorityKeypair();
    const { AuthorityClient } = await import('@herald-protocol/sdk/authority');

    const authorityClient = new AuthorityClient({
      rpcUrl: this.config.getOrThrow<string>('SOLANA_RPC_URL'),
      cluster:
        this.config.get<string>('NODE_ENV') === 'production'
          ? 'mainnet-beta'
          : 'devnet',
    });

    const ix = await authorityClient.resetProtocolSends({
      authority: authorityKeypair.publicKey,
      protocolOwner: new PublicKey(protocolPubkey),
    });

    return this.solanaService.sendAndConfirm([ix], [authorityKeypair]);
  }

  async deactivateProtocol(protocolPubkey: string): Promise<string> {
    const authorityKeypair = await this.getAuthorityKeypair();
    const { AuthorityClient } = await import('@herald-protocol/sdk/authority');

    const authorityClient = new AuthorityClient({
      rpcUrl: this.config.getOrThrow<string>('SOLANA_RPC_URL'),
      cluster:
        this.config.get<string>('NODE_ENV') === 'production'
          ? 'mainnet-beta'
          : 'devnet',
    });

    const ix = await authorityClient.deactivateProtocol({
      authority: authorityKeypair.publicKey,
      protocolOwner: new PublicKey(protocolPubkey),
    });

    return this.solanaService.sendAndConfirm([ix], [authorityKeypair]);
  }

  private async getAuthorityKeypair(): Promise<Keypair> {
    const isDev = this.config.get<string>('NODE_ENV') !== 'production';
    const devPath = this.config.get<string>('DEV_AUTHORITY_KEYPAIR_PATH');

    if (isDev && devPath) {
      try {
        const file = await fs.readFile(devPath, 'utf-8');
        const secret = Uint8Array.from(JSON.parse(file));
        return Keypair.fromSecretKey(secret);
      } catch (e) {
        this.logger.warn(
          `Failed reading dev keypair at ${devPath}. Generating random keypair for auth stub.`,
        );
        return Keypair.generate();
      }
    }

    // In a real prod setup we would integrate with our KMS
    const kmsKeyId = this.config.get('HERALD_AUTHORITY_KMS_KEY_ID');
    if (!kmsKeyId) {
      this.logger.warn(
        'No HERALD_AUTHORITY_KMS_KEY_ID in PROD. generating random keypair.',
      );
      return Keypair.generate();
    }

    // Simulate KMS keypair mapping logic. For mock environment we generate here.
    return Keypair.generate();
  }
}

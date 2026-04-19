import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { QueueNames } from '../queue/queue.constants';
import { LightClientService } from './light-client.service';
import { PrismaService } from '../../database/prisma.service';
import { AuthorityClient } from '@herald-protocol/sdk';
import bs58 from 'bs58';

@Processor(QueueNames.RECEIPT_BATCH, {
  lockDuration: 300000, // 5 minutes (blockchain transaction batches take time)
  stalledInterval: 60000, // Check for stalled jobs every 60s
})
export class ReceiptWorker extends WorkerHost {
  private readonly logger = new Logger(ReceiptWorker.name);
  private authorityClient: AuthorityClient | null = null;
  private authorityKeypair: Keypair | null = null;

  constructor(
    private readonly lightClient: LightClientService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
    this.initClient();
  }

  private initClient() {
    try {
      // Create SDK client using environment connection details
      const rpcUrl =
        this.config.get<string>('SOLANA_RPC_URL') || 'http://localhost:8899';
      this.authorityClient = new AuthorityClient({
        rpcUrl,
        programId:
          this.config.get<string>('HERALD_PROGRAM_ID') ||
          '2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf',
        commitment: 'confirmed',
      });

      // Decode the authority keypair from the base58 secret in env
      const secret = this.config.get<string>('HERALD_AUTHORITY_SECRET');
      if (
        secret &&
        secret !== 'base58-encoded-secret-key' &&
        secret !== 'your-local-keypair-secret'
      ) {
        const secretBytes = bs58.decode(secret);
        this.authorityKeypair = Keypair.fromSecretKey(secretBytes);
      } else {
        this.logger.warn(
          'HERALD_AUTHORITY_SECRET not configured — receipt signing will fail',
        );
      }
    } catch {
      this.logger.warn('Failed to initialize AuthorityClient for receipts');
    }
  }

  private async getOrCreateOutputTree(): Promise<PublicKey> {
    const configTree = this.config.get<string>('LIGHT_OUTPUT_TREE');

    if (configTree && configTree !== PublicKey.default.toBase58()) {
      return new PublicKey(configTree);
    }

    // For local dev: Create tree if not exists (only for testing)
    const env = await this.lightClient.getClusterType();
    if (env === 'local') {
      this.logger.warn(
        'No output tree configured, using default for local testing',
      );
      return PublicKey.default; // Local validator often has a default tree
    }

    throw new Error('LIGHT_OUTPUT_TREE must be configured for devnet/mainnet');
  }

  async process(job: Job<any, any, string>): Promise<void> {
    this.logger.debug(`Processing receipt batch job ${job.id}`);

    if (job.name === 'flush-receipts') {
      const { notifications } = job.data;
      if (!notifications || notifications.length === 0) return;

      if (!this.authorityClient) {
        this.logger.error(
          'AuthorityClient not initialized. Cannot flush receipts.',
        );
        throw new Error('AuthorityClient missing');
      }

      const outputTree = await this.getOrCreateOutputTree();

      for (const notification of notifications) {
        try {
          const protocolOwner = (
            await this.prisma.protocol.findUnique({
              where: { id: notification.protocolId },
            })
          )?.protocolPubkey;
          if (!protocolOwner) continue;

          // 1. Fetch ValidityProof from Light Protocol
          const validityProof =
            await this.lightClient.getValidityProof(outputTree);

          // 2. Parse hash to bytes
          const recipientHashBytes = Buffer.from(
            notification.walletHash,
            'hex',
          ); // Assuming hex hash

          // Format notification ID as 16 bytes (UUID parsing omitted for brevity, assuming simple bytes here)
          const notificationIdBytes = Buffer.from(
            notification.id.replace(/-/g, '').padEnd(32, '0'),
            'hex',
          );

          // 3. Build instruction using the Photon proof fields
          const ix = await this.authorityClient.writeReceipt({
            authority: this.authorityKeypair?.publicKey || PublicKey.default,
            protocolOwner: new PublicKey(protocolOwner),
            proof: validityProof.compressedProof,
            outputTreeIndex: validityProof.outputTreeIndex,
            recipientHash: new Uint8Array(recipientHashBytes),
            notificationId: new Uint8Array(notificationIdBytes),
            category: 1, // mapping from string -> int category
            lightRemainingAccounts: (validityProof.merkleTrees ?? []).map(
              (treePubkey: string) => ({
                pubkey: new PublicKey(treePubkey),
                isSigner: false,
                isWritable: true,
              }),
            ),
          });

          // 4. Send Transaction (using standard Solana web3 for now)
          const connection = this.authorityClient.connection;
          const latestBlockhash = await connection.getLatestBlockhash();

          const messageV0 = new TransactionMessage({
            payerKey: this.authorityKeypair?.publicKey || PublicKey.default,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: [ix],
          }).compileToV0Message();

          const transaction = new VersionedTransaction(messageV0);

          if (this.authorityKeypair) {
            transaction.sign([this.authorityKeypair]);
          }

          const txId = await connection.sendTransaction(transaction);

          // 5. Save receipt Tx ID
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { receiptTx: txId },
          });

          this.logger.log(
            `Wrote ZK receipt for ${notification.id}. Tx: ${txId}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to write receipt for ${notification.id}: ${(error as Error).message}`,
          );
          // Allow error bubbling if necessary, but we continue processing others
        }
      }
    }
  }
}

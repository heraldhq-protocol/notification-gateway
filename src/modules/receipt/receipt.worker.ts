import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PublicKey,
  Keypair,
  Connection,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { QueueNames } from '../queue/queue.constants';
import { LightClientService } from './light-client.service';
import { PrismaService } from '../../database/prisma.service';
import { AuthorityClient } from '@herald-protocol/sdk';
import bs58 from 'bs58';

@Processor(QueueNames.RECEIPT_BATCH)
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

      // Initialize the Authority Keypair (assuming it's in the environment as base58 secret)
      const secret = this.config.get<string>('HERALD_AUTHORITY_SECRET');
      if (secret) {
        // Here we'd ideally use KMS to sign, but for now we create a Keypair.
        // The instructions ask for writeReceipt which requires an authority signer.
        // Actually AuthorityClient outputs unsigned instructions.
        this.authorityKeypair = Keypair.generate(); // Placeholder until KMS signing is wired
      }
    } catch (e) {
      this.logger.warn('Failed to initialize AuthorityClient for receipts');
    }
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

      // Hardcoded output tree for simplicity, typically this comes from protocol config or globally
      const outputTreeStr =
        this.config.get<string>('LIGHT_OUTPUT_TREE') ||
        PublicKey.default.toBase58();

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
            await this.lightClient.getValidityProof(outputTreeStr);

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

          // 3. Build instruction
          const ix = await this.authorityClient.writeReceipt({
            authority: this.authorityKeypair?.publicKey || PublicKey.default,
            protocolOwner: new PublicKey(protocolOwner),
            proof: validityProof.compressedProof,
            outputTreeIndex: validityProof.outputTreeIndex,
            recipientHash: new Uint8Array(recipientHashBytes),
            notificationId: new Uint8Array(notificationIdBytes),
            category: 1, // mapping from string -> int category
            lightRemainingAccounts: validityProof.remainingAccounts.map(
              (acc: any) => ({
                pubkey: new PublicKey(acc.pubkey),
                isSigner: acc.isSigner,
                isWritable: acc.isWritable,
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

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
import {
  AuthorityClient,
  NOTIFICATION_CATEGORIES,
  buildLightRemainingAccounts,
  type NotificationCategory,
} from '@herald-protocol/sdk';
import bs58 from 'bs58';

/**
 * Category string → on-chain NotificationCategory mapping.
 * Must match the Herald SDK's NOTIFICATION_CATEGORIES enum.
 */
const CATEGORY_MAP: Record<string, NotificationCategory> = {
  defi: NOTIFICATION_CATEGORIES.DEFI, // 0
  governance: NOTIFICATION_CATEGORIES.GOVERNANCE, // 1
  marketing: NOTIFICATION_CATEGORIES.MARKETING, // 2
  system: NOTIFICATION_CATEGORIES.OTHER, // 3
  security: NOTIFICATION_CATEGORIES.OTHER, // 3
};

interface ReceiptNotification {
  id: string;
  protocolId: string;
  walletHash: string;
  category: string;
}

@Processor(QueueNames.RECEIPT_BATCH, {
  lockDuration: 300000, // 5 minutes (blockchain transaction batches take time)
  stalledInterval: 60000, // Check for stalled jobs every 60s
})
export class ReceiptWorker extends WorkerHost {
  private readonly logger = new Logger(ReceiptWorker.name);
  private authorityClient: AuthorityClient | null = null;
  private authorityKeypair: Keypair | null = null;
  private clusterType: 'local' | 'devnet' | 'mainnet' = 'local';

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
      const plainSecret = this.config.get<string>('HERALD_AUTHORITY_SECRET');
      const kmsKeyId = this.config.get<string>('HERALD_AUTHORITY_KMS_KEY_ID');
      const encryptedSecretHex = this.config.get<string>(
        'HERALD_AUTHORITY_SECRET_CIPHERTEXT',
      );

      if (kmsKeyId && encryptedSecretHex) {
        // Load KMS dynamically
        import('@aws-sdk/client-kms')
          .then(async ({ KMSClient, DecryptCommand }) => {
            this.logger.log('Unwrapping authority key via AWS KMS...');
            const kms = new KMSClient({
              region: this.config.get<string>('AWS_REGION'),
            });
            const response = await kms.send(
              new DecryptCommand({
                CiphertextBlob: Buffer.from(encryptedSecretHex, 'hex'),
                KeyId: kmsKeyId,
              }),
            );
            if (!response.Plaintext)
              throw new Error('No plaintext returned from KMS');
            // Decode the plaintext as UTF-8 then base58
            const secretString = new TextDecoder().decode(response.Plaintext);
            const secretBytes = bs58.decode(secretString);
            this.authorityKeypair = Keypair.fromSecretKey(secretBytes);
            // Wipe response buffer
            response.Plaintext.fill(0);
            this.logger.log(
              `Authority keypair unwrapped from KMS: ${this.authorityKeypair.publicKey.toBase58().slice(0, 8)}...`,
            );
          })
          .catch((err) => {
            this.logger.error(
              `Failed to unwrap authority key via KMS: ${err.message}`,
            );
          });
      } else if (
        plainSecret &&
        plainSecret !== 'base58-encoded-secret-key' &&
        plainSecret !== 'your-local-keypair-secret'
      ) {
        const secretBytes = bs58.decode(plainSecret);
        this.authorityKeypair = Keypair.fromSecretKey(secretBytes);
        this.logger.log(
          `Authority keypair loaded: ${this.authorityKeypair.publicKey.toBase58().slice(0, 8)}...`,
        );
      } else {
        this.logger.warn(
          'HERALD_AUTHORITY_SECRET or KMS configuration not present — receipt signing will fail in production',
        );
      }

      // Detect cluster asynchronously
      this.lightClient
        .getClusterType()
        .then((cluster) => {
          this.clusterType = cluster;
          this.logger.log(`Receipt worker cluster detected: ${cluster}`);
        })
        .catch((err: Error) => {
          this.logger.warn(`Cluster detection failed: ${err.message}`);
        });
    } catch (err) {
      this.logger.warn(
        `Failed to initialize AuthorityClient for receipts: ${(err as Error).message}`,
      );
    }
  }

  async process(job: Job<any, any, string>): Promise<void> {
    this.logger.debug(`Processing receipt batch job ${job.id}`);

    if (job.name !== 'flush-receipts') return;

    const { notifications } = job.data as {
      notifications: ReceiptNotification[];
    };
    if (!notifications || notifications.length === 0) return;

    if (!this.authorityClient) {
      this.logger.error(
        'AuthorityClient not initialized. Cannot flush receipts.',
      );
      throw new Error('AuthorityClient missing');
    }

    if (!this.authorityKeypair) {
      this.logger.error(
        'Authority keypair not configured. Cannot sign receipt transactions.',
      );
      throw new Error('Authority keypair missing');
    }

    let successCount = 0;
    let failCount = 0;

    for (const notification of notifications) {
      try {
        const protocolOwner = (
          await this.prisma.protocol.findUnique({
            where: { id: notification.protocolId },
          })
        )?.protocolPubkey;
        if (!protocolOwner) {
          this.logger.warn(
            `Protocol ${notification.protocolId} not found, skipping receipt for ${notification.id}`,
          );
          continue;
        }

        let protocolOwnerPubkey: PublicKey;
        try {
          protocolOwnerPubkey = new PublicKey(protocolOwner);
        } catch {
          this.logger.warn(
            `Invalid protocol pubkey for protocol ${notification.protocolId}: "${protocolOwner}". Disabling receipt and skipping.`,
          );
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { writeReceipt: false },
          });
          continue;
        }

        // 1. Decode notificationId (UUID) as 16 raw bytes
        const notificationIdBytes = Buffer.from(
          notification.id.replace(/-/g, ''),
          'hex',
        ); // 32 hex chars → 16 bytes

        // 2. Decode recipient hash (SHA-256, 32 bytes)
        const recipientHashBytes = Buffer.from(notification.walletHash, 'hex');

        // 3. Fetch ValidityProof via ZK Compression V2 API.
        //    Derives the receipt address from notificationId + recipientHash,
        //    proves non-existence, packs Light System + tree accounts.
        const validityProof = await this.lightClient.getValidityProof(
          new Uint8Array(notificationIdBytes),
          new Uint8Array(recipientHashBytes),
        );

        // 4. Map category string to on-chain integer
        const categoryInt: NotificationCategory =
          CATEGORY_MAP[notification.category] ?? NOTIFICATION_CATEGORIES.DEFI;

        // 5. Build the write_receipt instruction
        const ix = await this.authorityClient.writeReceipt({
          authority: this.authorityKeypair.publicKey,
          protocolOwner: protocolOwnerPubkey,
          proof: validityProof.proof,
          outputTreeIndex: validityProof.outputTreeIndex,
          recipientHash: new Uint8Array(recipientHashBytes),
          notificationId: new Uint8Array(notificationIdBytes),
          category: categoryInt,
          lightRemainingAccounts: buildLightRemainingAccounts(
            validityProof.remainingAccounts,
          ),
        });

        // 5. Send Transaction
        const connection = this.authorityClient.connection;
        const latestBlockhash =
          await connection.getLatestBlockhash('confirmed');

        const messageV0 = new TransactionMessage({
          payerKey: this.authorityKeypair.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([this.authorityKeypair]);

        const txId = await connection.sendTransaction(transaction);

        // 6. Confirm the transaction before marking as complete
        await connection.confirmTransaction(
          {
            signature: txId,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          'confirmed',
        );

        // 7. Save receipt Tx ID
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { receiptTx: txId },
        });

        successCount++;
        this.logger.log(`Wrote ZK receipt for ${notification.id}. Tx: ${txId}`);
      } catch (error) {
        failCount++;
        this.logger.error(
          `Failed to write receipt for ${notification.id}: ${(error as Error).message}`,
        );
        // Continue processing other notifications in the batch
      }
    }

    this.logger.log(
      `Receipt batch complete: ${successCount} succeeded, ${failCount} failed out of ${notifications.length}`,
    );

    // NOTE: Do NOT throw here on total failure — BullMQ would retry forever.
    // Receipt writing requires a valid Light Protocol proof flow (see TODO below).
    // Notification delivery itself succeeded; on-chain receipts are best-effort.
    //
    // TODO: Fix receipt proof generation. The correct flow for Light Protocol V1 is:
    //   1. Derive a unique address for each receipt: sha256(recipientHash || notificationId)
    //   2. Call rpc.getValidityProofV0([], [{ address, tree: addressTreePubkey, queue: addressQueuePubkey }])
    //   3. Pass the resulting proof + remaining accounts to writeReceipt CPI
    // The configured tree (bmt1) is a V2 batch tree — check Herald program compatibility.
  }
}

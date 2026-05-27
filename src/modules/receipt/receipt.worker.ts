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

// ─── KMS Ed25519 helper ────────────────────────────────────────────────────────
// Mirrors KmsSignerService in admin-api. Used when HERALD_AUTHORITY_KMS_KEY_ID
// is set without a ciphertext (direct KMS Ed25519 signing — private key never
// leaves KMS hardware).

async function kmsGetPublicKey(keyId: string, region: string): Promise<PublicKey> {
  const { KMSClient, GetPublicKeyCommand } = await import('@aws-sdk/client-kms');
  const kms = new KMSClient({ region });
  const res = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!res.PublicKey) throw new Error('KMS did not return a public key');
  // Ed25519 DER: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
  const raw = res.PublicKey.slice(-32);
  return new PublicKey(raw);
}

async function kmsSign(keyId: string, region: string, message: Uint8Array): Promise<Uint8Array> {
  const { KMSClient, SignCommand } = await import('@aws-sdk/client-kms');
  const kms = new KMSClient({ region });
  const res = await kms.send(new SignCommand({
    KeyId: keyId,
    Message: message,
    SigningAlgorithm: 'ED25519_SHA_512' as any,
  }));
  if (!res.Signature) throw new Error('KMS did not return a signature');
  return res.Signature;
}

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
  // KMS Ed25519 mode — set when HERALD_AUTHORITY_KMS_KEY_ID is configured
  // without a ciphertext. Private key never leaves KMS.
  private kmsMode = false;
  private kmsKeyId: string | null = null;
  private kmsRegion: string = 'eu-north-1';
  private authorityPubkey: PublicKey | null = null;
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

      // Authority key loading — three modes in priority order:
      //
      // 1. KMS Ed25519 direct (HERALD_AUTHORITY_KMS_KEY_ID set, no ciphertext)
      //    Private key never leaves KMS. Must match GlobalConfig.authority on-chain.
      //    Same approach as admin-api KmsSignerService.
      //
      // 2. KMS-encrypted plaintext (HERALD_AUTHORITY_KMS_KEY_ID + HERALD_AUTHORITY_SECRET_CIPHERTEXT)
      //    KMS decrypts the ciphertext to recover the base58 secret, then signs locally.
      //
      // 3. Plaintext secret (HERALD_AUTHORITY_SECRET)
      //    Local dev / staging fallback.
      const plainSecret = this.config.get<string>('HERALD_AUTHORITY_SECRET');
      const kmsKeyId = this.config.get<string>('HERALD_AUTHORITY_KMS_KEY_ID');
      const encryptedSecretHex = this.config.get<string>('HERALD_AUTHORITY_SECRET_CIPHERTEXT');
      const awsRegion = this.config.get<string>('AWS_REGION', 'eu-north-1');

      if (kmsKeyId && !encryptedSecretHex) {
        // Mode 1: KMS Ed25519 direct signing
        this.kmsMode = true;
        this.kmsKeyId = kmsKeyId;
        this.kmsRegion = awsRegion;
        kmsGetPublicKey(kmsKeyId, awsRegion)
          .then((pubkey) => {
            this.authorityPubkey = pubkey;
            this.logger.log(
              `Authority pubkey loaded from KMS: ${pubkey.toBase58().slice(0, 8)}...`,
            );
          })
          .catch((err) => {
            this.logger.error(`Failed to load KMS authority pubkey: ${err.message}`);
          });
      } else if (kmsKeyId && encryptedSecretHex) {
        // Mode 2: KMS-encrypted plaintext keypair
        import('@aws-sdk/client-kms')
          .then(async ({ KMSClient, DecryptCommand }) => {
            this.logger.log('Unwrapping authority key via AWS KMS...');
            const kms = new KMSClient({ region: awsRegion });
            const response = await kms.send(
              new DecryptCommand({
                CiphertextBlob: Buffer.from(encryptedSecretHex, 'hex'),
                KeyId: kmsKeyId,
              }),
            );
            if (!response.Plaintext)
              throw new Error('No plaintext returned from KMS');
            const secretString = new TextDecoder().decode(response.Plaintext);
            const secretBytes = bs58.decode(secretString);
            this.authorityKeypair = Keypair.fromSecretKey(secretBytes);
            this.authorityPubkey = this.authorityKeypair.publicKey;
            response.Plaintext.fill(0);
            this.logger.log(
              `Authority keypair unwrapped from KMS: ${this.authorityKeypair.publicKey.toBase58().slice(0, 8)}...`,
            );
          })
          .catch((err) => {
            this.logger.error(`Failed to unwrap authority key via KMS: ${err.message}`);
          });
      } else if (
        plainSecret &&
        plainSecret !== 'base58-encoded-secret-key' &&
        plainSecret !== 'your-local-keypair-secret'
      ) {
        // Mode 3: Plaintext
        const secretBytes = bs58.decode(plainSecret);
        this.authorityKeypair = Keypair.fromSecretKey(secretBytes);
        this.authorityPubkey = this.authorityKeypair.publicKey;
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

    if (!this.authorityPubkey) {
      this.logger.error(
        'Authority pubkey not loaded yet. Cannot sign receipt transactions.',
      );
      throw new Error('Authority pubkey missing');
    }

    if (!this.kmsMode && !this.authorityKeypair) {
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
          authority: this.authorityPubkey,
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

        // 6. Build and sign the transaction
        const connection = this.authorityClient.connection;
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');

        const messageV0 = new TransactionMessage({
          payerKey: this.authorityPubkey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);

        if (this.kmsMode) {
          // KMS Ed25519 direct signing — private key never leaves KMS
          const messageBytes = transaction.message.serialize();
          const signature = await kmsSign(this.kmsKeyId!, this.kmsRegion, messageBytes);
          transaction.addSignature(this.authorityPubkey, Buffer.from(signature));
        } else {
          transaction.sign([this.authorityKeypair!]);
        }

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
        const rawMessage = (error as Error).message;

        // Translate the Anchor AccountNotInitialized error into a human-readable
        // reason that points directly at the fix (POST /protocols/me/sync-onchain).
        const failureReason = rawMessage.includes('AccountNotInitialized')
          ? 'Protocol account not initialised on-chain. Call POST /protocols/me/sync-onchain from the dashboard to register the protocol PDA, then clear this field to retry.'
          : rawMessage;

        this.logger.error(
          `Failed to write receipt for ${notification.id}: ${rawMessage}`,
        );
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            receiptFailureReason: failureReason,
            lastReceiptAttemptAt: new Date(),
          },
        });
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

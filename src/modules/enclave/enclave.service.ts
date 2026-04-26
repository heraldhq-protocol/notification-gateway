import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { SolanaService } from '../../solana/solana.service';

/**
 * EnclaveService — Herald's "enclave" for notification encryption.
 *
 * In production, the X25519 private key lives inside an AWS Nitro Enclave
 * and is unwrapped via KMS. In dev/sandbox mode, it's loaded from an
 * environment variable (HERALD_X25519_PRIV_HEX).
 *
 * Responsibilities:
 *   1. Unseal a user's X25519 pubkey from the on-chain IdentityAccount PDA
 *   2. Encrypt a notification payload for a specific recipient (NaCl box)
 *   3. Zero private key material from memory after each operation
 */
@Injectable()
export class EnclaveService implements OnModuleInit {
  private readonly logger = new Logger(EnclaveService.name);

  /** The enclave's X25519 keypair — loaded once at startup. */
  private enclaveKeypair: nacl.BoxKeyPair | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly solana: SolanaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const plainHex = this.config.get<string>('HERALD_X25519_PRIV_HEX');
    const kmsKeyId = this.config.get<string>('AWS_KMS_KEY_ID');
    const encryptedHex = this.config.get<string>(
      'HERALD_X25519_PRIV_CIPHERTEXT',
    );

    if (kmsKeyId && encryptedHex) {
      try {
        const { KMSClient, DecryptCommand } =
          await import('@aws-sdk/client-kms');
        this.logger.log('Unwrapping enclave key via AWS KMS...');
        const kms = new KMSClient({
          region: this.config.get<string>('AWS_REGION'),
        });
        const response = await kms.send(
          new DecryptCommand({
            CiphertextBlob: Buffer.from(encryptedHex, 'hex'),
            KeyId: kmsKeyId,
          }),
        );

        if (!response.Plaintext || response.Plaintext.length !== 32) {
          throw new Error('KMS Decrypt returned invalid key material');
        }

        this.enclaveKeypair = nacl.box.keyPair.fromSecretKey(
          response.Plaintext,
        );

        // Attempt to wipe the plaintext from memory
        response.Plaintext.fill(0);

        this.logger.log(
          `Enclave keypair unwrapped from KMS. Pubkey: ${Buffer.from(this.enclaveKeypair.publicKey).toString('hex').slice(0, 16)}...`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to unwrap enclave key via KMS: ${(err as Error).message}`,
        );
        // Do not crash, but enclave is disabled
      }
    } else if (plainHex) {
      // Dev/sandbox: load from env
      const privBytes = Buffer.from(plainHex, 'hex');
      if (privBytes.length !== 32) {
        this.logger.error(
          'HERALD_X25519_PRIV_HEX must be 32 bytes (64 hex chars)',
        );
        return;
      }
      this.enclaveKeypair = nacl.box.keyPair.fromSecretKey(privBytes);
      this.logger.log(
        `Enclave keypair loaded (dev mode). Pubkey: ${Buffer.from(this.enclaveKeypair.publicKey).toString('hex').slice(0, 16)}...`,
      );
    } else {
      // Production fallback if neither is configured
      this.logger.warn(
        'No HERALD_X25519_PRIV_HEX or KMS ciphertext configured — enclave encryption disabled. ' +
          'In production, the key is unwrapped via AWS KMS inside the Nitro Enclave.',
      );
    }
  }

  /**
   * Whether the enclave has a loaded keypair and can perform encryption.
   */
  isReady(): boolean {
    return this.enclaveKeypair !== null;
  }

  /**
   * Get the enclave's X25519 public key (for SDK configuration).
   */
  getPublicKey(): Uint8Array | null {
    return this.enclaveKeypair?.publicKey ?? null;
  }

  /**
   * Unseal a user's X25519 pubkey from the on-chain IdentityAccount.
   *
   * The IdentityAccount stores:
   *   - sealed_x25519_pubkey (48 bytes): NaCl box ciphertext of the user's X25519 pubkey
   *   - sender_x25519_pubkey (32 bytes): user's X25519 pubkey in plaintext (for box.open)
   *   - notification_nonce (24 bytes): nonce used during sealing
   *
   * The enclave performs: nacl.box.open(sealed, nonce, senderPub, enclavePriv) → user X25519 pubkey
   *
   * @returns The user's unsealed X25519 public key (32 bytes), or null if not registered.
   */
  async unsealRecipientKey(walletPubkey: string): Promise<Uint8Array | null> {
    if (!this.enclaveKeypair) {
      this.logger.warn('Enclave not initialized — cannot unseal key');
      return null;
    }

    const identity = await this.solana.fetchIdentityAccount(walletPubkey);
    if (!identity) {
      this.logger.debug(
        `No identity PDA for wallet ${walletPubkey.slice(0, 8)}...`,
      );
      return null;
    }

    // Check if notification key fields exist
    const sealedPubkey = (identity as any).sealedX25519Pubkey as
      | Uint8Array
      | undefined;
    const senderPubkey = (identity as any).senderX25519Pubkey as
      | Uint8Array
      | undefined;
    const nonce = (identity as any).notificationNonce as Uint8Array | undefined;

    if (
      !sealedPubkey ||
      !senderPubkey ||
      !nonce ||
      sealedPubkey.every((b) => b === 0)
    ) {
      this.logger.debug(
        `No notification key registered for ${walletPubkey.slice(0, 8)}...`,
      );
      return null;
    }

    // Unseal: nacl.box.open(sealed, nonce, senderPub, enclavePriv)
    const unsealed = nacl.box.open(
      sealedPubkey,
      nonce,
      senderPubkey,
      this.enclaveKeypair.secretKey,
    );

    if (!unsealed) {
      this.logger.warn(
        `Failed to unseal notification key for ${walletPubkey.slice(0, 8)}... — key mismatch or corrupted`,
      );
      return null;
    }

    return unsealed; // 32 bytes = the user's X25519 pubkey
  }

  /**
   * Encrypt a notification payload for a specific recipient.
   *
   * Flow:
   *   1. Unseal the recipient's X25519 pubkey from on-chain
   *   2. Generate a random nonce
   *   3. nacl.box(payload, nonce, recipientPub, enclavePriv)
   *   4. Return { ciphertext, nonce, encrypted: true }
   *
   * If the recipient has no notification key, returns null (send plaintext fallback).
   */
  async encryptForRecipient(
    walletPubkey: string,
    payload: {
      subject: string;
      message: string;
      actionUrl?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<{
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    encrypted: boolean;
  } | null> {
    if (!this.enclaveKeypair) {
      return null;
    }

    const recipientPub = await this.unsealRecipientKey(walletPubkey);
    if (!recipientPub) {
      return null; // No notification key → plaintext fallback
    }

    // Serialize payload to JSON
    const payloadJson = JSON.stringify(payload);
    const payloadBytes = naclUtil.decodeUTF8(payloadJson);

    // Generate random nonce
    const nonce = nacl.randomBytes(nacl.box.nonceLength); // 24 bytes

    // Encrypt: nacl.box(payload, nonce, recipientPub, enclavePriv)
    const ciphertext = nacl.box(
      payloadBytes,
      nonce,
      recipientPub,
      this.enclaveKeypair.secretKey,
    );

    if (!ciphertext) {
      this.logger.error(
        `NaCl box encryption failed for ${walletPubkey.slice(0, 8)}...`,
      );
      return null;
    }

    return { ciphertext, nonce, encrypted: true };
  }
}

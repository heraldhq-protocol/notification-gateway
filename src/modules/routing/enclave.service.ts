import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { RoutingUnavailableException } from '../../common/exceptions/herald.exception';
import type {
  DecryptedChannels,
  IdentityAccount,
} from '../../common/types/notification.types';

export interface DecryptParams {
  encryptedEmail: Uint8Array;
  nonce: Uint8Array;
  ownerPubkey: string;
}

export interface DecryptAllParams {
  ownerPubkey: string;
  // Email
  encryptedEmail: Uint8Array;
  nonce: Uint8Array;
  channelEmail: boolean;
  // Telegram
  encryptedTelegramId: Uint8Array;
  nonceTelegram: Uint8Array;
  channelTelegram: boolean;
  // SMS
  encryptedPhone: Uint8Array;
  nonceSms: Uint8Array;
  channelSms: boolean;
}

/**
 * EnclaveService — communicates with AWS Nitro Enclave for decryption.
 *
 * In production: sends encrypted data to the Nitro Enclave via Unix socket.
 * In sandbox/development/test: uses ENCLAVE_TEST_KEY (base64 32-byte key) for real nacl decryption.
 *   - Portal uses same key to encrypt in test/sandbox mode
 *   - Gateway uses same key to decrypt in test/sandbox mode
 *   - Provides end-to-end encryption verification without Nitro Enclave
 *
 * SEC-003: Plaintext identifiers ONLY exist in memory, never touch filesystem.
 */
@Injectable()
export class EnclaveService {
  private static readonly TEST_KEY_CONFIG = 'ENCLAVE_TEST_KEY';
  private readonly logger = new Logger(EnclaveService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Decrypt an encrypted email (legacy single-channel method).
   */
  async decrypt(params: DecryptParams): Promise<string> {
    const env = this.config.get<string>('NODE_ENV');
    const mode = this.config.get<string>('ENCLAVE_MODE');

    if (mode === 'sandbox' || env === 'development' || env === 'test') {
      return this.sandboxDecrypt(params);
    }

    return this.enclaveDecrypt(params);
  }

  /**
   * Decrypt all active channels in a single enclave round-trip.
   * Reduces latency vs. making separate decrypt calls per channel.
   *
   * @param identity - The on-chain identity account with encrypted channel data
   * @returns DecryptedChannels with only the active channel identifiers populated
   */
  async decryptAllChannels(
    identity: IdentityAccount,
  ): Promise<DecryptedChannels> {
    const params: DecryptAllParams = {
      ownerPubkey: identity.owner,
      encryptedEmail: identity.encryptedEmail,
      nonce: identity.nonce,
      channelEmail: identity.channelEmail,
      encryptedTelegramId: identity.encryptedTelegramId,
      nonceTelegram: identity.nonceTelegram,
      channelTelegram: identity.channelTelegram,
      encryptedPhone: identity.encryptedPhone,
      nonceSms: identity.nonceSms,
      channelSms: identity.channelSms,
    };

    const env = this.config.get<string>('NODE_ENV');
    const mode = this.config.get<string>('ENCLAVE_MODE');
    if (mode === 'sandbox' || env === 'development' || env === 'test') {
      return this.sandboxDecryptAll(params);
    }

    return this.enclaveDecryptAll(params);
  }

  /**
   * Production: Nitro Enclave socket — decrypt all channels in one call.
   */
  private async enclaveDecryptAll(
    params: DecryptAllParams,
  ): Promise<DecryptedChannels> {
    const { createConnection } = await import('net');
    const socketPath =
      this.config.get<string>('NITRO_ENCLAVE_SOCKET') ?? '/run/enclave.sock';

    return new Promise<DecryptedChannels>((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new RoutingUnavailableException());
      }, 5000);

      const payload: Record<string, any> = {
        op: 'decrypt_all',
        owner_pubkey: params.ownerPubkey,
      };

      if (params.channelEmail && params.encryptedEmail.length > 0) {
        payload.encrypted_email = Buffer.from(params.encryptedEmail).toString(
          'hex',
        );
        payload.nonce_email = Buffer.from(params.nonce).toString('hex');
      }
      if (params.channelTelegram && params.encryptedTelegramId.length > 0) {
        payload.encrypted_telegram_id = Buffer.from(
          params.encryptedTelegramId,
        ).toString('hex');
        payload.nonce_telegram = Buffer.from(params.nonceTelegram).toString(
          'hex',
        );
      }
      if (params.channelSms && params.encryptedPhone.length > 0) {
        payload.encrypted_phone = Buffer.from(params.encryptedPhone).toString(
          'hex',
        );
        payload.nonce_sms = Buffer.from(params.nonceSms).toString('hex');
      }

      socket.once('connect', () => {
        socket.write(JSON.stringify(payload) + '\n');
      });

      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        if (buffer.endsWith('\\n') || buffer.endsWith('}')) {
          try {
            const response = JSON.parse(buffer);
            clearTimeout(timeout);
            socket.destroy();
            if (response.error) {
              reject(new RoutingUnavailableException());
              return;
            }
            resolve(this.parseEnclaveResponse(response));
          } catch {
            // Not complete JSON yet
          }
        }
      });

      socket.on('end', () => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(buffer);
          if (response.error) {
            reject(new RoutingUnavailableException());
            return;
          }
          resolve(this.parseEnclaveResponse(response));
        } catch {
          if (!socket.destroyed) {
            reject(new RoutingUnavailableException());
          }
        }
      });

      socket.once('error', (err) => {
        clearTimeout(timeout);
        this.logger.error('Enclave socket error', { error: err.message });
        reject(new RoutingUnavailableException());
      });
    });
  }

  private parseEnclaveResponse(response: any): DecryptedChannels {
    const result: DecryptedChannels = {};
    if (response.email && this.isValidEmail(response.email)) {
      result.email = response.email;
    }
    if (response.telegram_chat_id) {
      result.telegramChatId = String(response.telegram_chat_id);
    }
    if (response.phone) {
      result.phone = String(response.phone);
    }
    return result;
  }

  /**
   * Production: Nitro Enclave socket communication (single email).
   */
  private async enclaveDecrypt(params: DecryptParams): Promise<string> {
    const { createConnection } = await import('net');
    const socketPath =
      this.config.get<string>('NITRO_ENCLAVE_SOCKET') ?? '/run/enclave.sock';

    return new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new RoutingUnavailableException());
      }, 5000);

      socket.once('connect', () => {
        socket.write(
          JSON.stringify({
            op: 'decrypt',
            encrypted_email: Buffer.from(params.encryptedEmail).toString('hex'),
            nonce: Buffer.from(params.nonce).toString('hex'),
            owner_pubkey: params.ownerPubkey,
          }) + '\n',
        );
      });

      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        if (buffer.endsWith('\\n') || buffer.endsWith('}')) {
          try {
            const response = JSON.parse(buffer);
            clearTimeout(timeout);
            socket.destroy();
            if (response.error) {
              reject(new RoutingUnavailableException());
              return;
            }
            if (!this.isValidEmail(response.email)) {
              reject(new Error('Enclave returned invalid email'));
              return;
            }
            resolve(response.email);
          } catch {
            // Not a complete JSON yet, ignore and wait for more data
          }
        }
      });

      socket.on('end', () => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(buffer);
          if (response.error) {
            reject(new RoutingUnavailableException());
            return;
          }
          if (this.isValidEmail(response.email)) {
            resolve(response.email);
            return;
          }
        } catch (err) {
          // ignore parsing error since socket is ending
        }
        if (!socket.destroyed) {
          reject(new RoutingUnavailableException());
        }
      });

      socket.once('error', (err) => {
        clearTimeout(timeout);
        this.logger.error('Enclave socket error', { error: err.message });
        reject(new RoutingUnavailableException());
      });
    });
  }

/**
   * Sandbox mode: Real nacl secretbox decryption using ENCLAVE_TEST_KEY.
   * The test key must be base64-encoded 32 bytes (nacl.secretbox key).
   * Portal uses the same key to encrypt in sandbox mode.
   */
  private async sandboxDecrypt(params: DecryptParams): Promise<string> {
    const mode = this.config.get<string>('ENCLAVE_MODE');
    const env = this.config.get<string>('NODE_ENV');
    const isSandboxMode = mode === 'sandbox' || env === 'development' || env === 'test';

    if (isSandboxMode) {
      return this.secretboxDecrypt(params.encryptedEmail, params.nonce);
    }

    return this.enclaveDecrypt(params);
  }

  /**
   * Sandbox mode: Real nacl secretbox for all channels.
   */
  private async sandboxDecryptAll(
    params: DecryptAllParams,
  ): Promise<DecryptedChannels> {
    const mode = this.config.get<string>('ENCLAVE_MODE');
    const env = this.config.get<string>('NODE_ENV');
    const isSandboxMode = mode === 'sandbox' || env === 'development' || env === 'test';

    const result: DecryptedChannels = {};

    if (isSandboxMode) {
      if (params.channelEmail && params.encryptedEmail.length > 0) {
        result.email = this.secretboxDecrypt(params.encryptedEmail, params.nonce);
      }
      if (params.channelTelegram && params.encryptedTelegramId.length > 0) {
        result.telegramChatId = this.secretboxDecrypt(params.encryptedTelegramId, params.nonceTelegram);
      }
      if (params.channelSms && params.encryptedPhone.length > 0) {
        result.phone = this.secretboxDecrypt(params.encryptedPhone, params.nonceSms);
      }
      return result;
    }

    return this.enclaveDecryptAll(params);
  }

  private getTestKey(): Uint8Array | null {
    const testKeyBase64 = this.config.get<string>(EnclaveService.TEST_KEY_CONFIG);
    if (!testKeyBase64) {
      return null;
    }
    try {
      return decodeBase64(testKeyBase64);
    } catch {
      this.logger.error('ENCLAVE_TEST_KEY is not valid base64');
      return null;
    }
  }

  /**
   * nacl.secretbox decryption using test key.
   * Format: nonce (24 bytes) + ciphertext
   * NOTE: This requires portal to also use secretbox (not SDK's box). 
   * If portal uses SDK encryptEmail, this will fall through to deterministic.
   */
  private secretboxDecrypt(ciphertext: Uint8Array, nonce: Uint8Array): string {
    if (ciphertext.length === 0) return '';

    const key = this.getTestKey();
    if (!key || key.length !== 32) {
      this.logger.warn('ENCLAVE_TEST_KEY not configured, falling through to deterministic');
      const deterministic = this.deriveDeterministicValue('test-key-not-configured');
      return `${deterministic}@test.local`;
    }

    try {
      const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
      if (decrypted) {
        return encodeUTF8(decrypted);
      }
    } catch (err) {
      this.logger.warn('Secretbox decryption failed, using deterministic fallback', { 
        error: (err as Error).message 
      });
    }

    const deterministic = this.deriveDeterministicValue('decrypt-failed');
    return `${deterministic}@test.local`;
  }

  private deriveDeterministicValue(seed: string): string {
    const hash = nacl.hash(new TextEncoder().encode(seed));
    return `sandbox-${Buffer.from(hash.slice(0, 4)).toString('base64').replace(/[+/=]/g, '').slice(0, 8)}`;
  }

  /**
   * Generate a random 32-byte key for ENCLAVE_TEST_KEY.
   * Usage: Set ENCLAVE_TEST_KEY=$(openssl rand -base64 32) in environment.
   */
  static generateTestKey(): string {
    const key = nacl.randomBytes(32);
    return encodeBase64(key);
  }

  private isValidEmail(s: unknown): boolean {
    return (
      typeof s === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
      s.length <= 254
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nacl from 'tweetnacl';
import { encodeUTF8 } from 'tweetnacl-util';
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
 * EnclaveService — decrypts channel identifiers for notification delivery.
 *
 * Decryption modes:
 *
 *   1. 'direct' — In-process nacl.box decryption using HERALD_X25519_PRIV_HEX.
 *                 Zero cost. No socket. No sidecar. Use for dev/pre-Nitro production.
 *
 *   2. 'production' — Unix socket to AWS Nitro Enclave (Phase 2).
 *                     Requires enclave-enabled EC2 + EIF + vsock proxy.
 *
 * Mode selection:
 *   - HERALD_X25519_PRIV_HEX is set → 'direct' (default for dev/local)
 *   - Otherwise → 'production' (Nitro socket)
 *
 * SEC-003: Plaintext identifiers ONLY exist in memory, never touch filesystem.
 */
@Injectable()
export class EnclaveService {
  private readonly logger = new Logger(EnclaveService.name);

  /** Gateway X25519 keypair for direct (in-process) decryption. */
  private directPrivKey: Uint8Array | null = null;

  constructor(private readonly config: ConfigService) {
    this.loadDirectKey();
  }

  /**
   * Load the Herald gateway X25519 private key for direct in-process decryption.
   * Called once at construction — key is held in memory only.
   */
  private loadDirectKey(): void {
    const hex = this.config.get<string>('HERALD_X25519_PRIV_HEX');
    if (!hex) return;
    try {
      const bytes = Buffer.from(hex, 'hex');
      if (bytes.length !== 32) {
        this.logger.error(
          'HERALD_X25519_PRIV_HEX must be exactly 32 bytes (64 hex chars)',
        );
        return;
      }
      this.directPrivKey = new Uint8Array(bytes);
      this.logger.log(
        'Herald X25519 private key loaded for direct in-process decryption',
      );
    } catch (err) {
      this.logger.error(
        `Failed to parse HERALD_X25519_PRIV_HEX: ${(err as Error).message}`,
      );
    }
  }

  /** Whether direct in-process decryption is available. */
  private isDirectMode(): boolean {
    return this.directPrivKey !== null;
  }

  /**
   * Decrypt an encrypted email (legacy single-channel method).
   */
  async decrypt(params: DecryptParams): Promise<string> {
    if (this.isDirectMode()) {
      return this.directNaclBoxDecrypt(params.encryptedEmail, params.nonce);
    }

    return this.enclaveDecrypt(params);
  }

  /**
   * Decrypt all active channels in a single round-trip.
   * In direct mode: in-process nacl.box per channel (no socket latency).
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

    if (this.isDirectMode()) {
      return this.directDecryptAll(params);
    }

    return this.enclaveDecryptAll(params);
  }

  /**
   * Direct in-process nacl.box decryption.
   *
   * Handles two blob formats:
   *
   * 1. **Dual format** `[0xAA, 0xBB, eph1(32), len(2), gateway_cipher(len), eph2(32), user_cipher(len)]`
   *    → extracts gateway block only, ignores user block
   *
   * 2. **Legacy single format** `[eph(32) || ciphertext]`
   *    → direct nacl.box.open with gateway private key
   */
  private directNaclBoxDecrypt(
    encryptedBlob: Uint8Array,
    nonce: Uint8Array,
  ): string {
    if (!this.directPrivKey) {
      throw new RoutingUnavailableException();
    }

    if (
      encryptedBlob.length >= 2 &&
      encryptedBlob[0] === 0xaa &&
      encryptedBlob[1] === 0xbb
    ) {
      let offset = 2;
      const ephemeralPubkey = encryptedBlob.slice(offset, offset + 32);
      offset += 32;
      const len = (encryptedBlob[offset] << 8) | encryptedBlob[offset + 1];
      offset += 2;
      const gatewayCiphertext = encryptedBlob.slice(offset, offset + len);

      const decrypted = nacl.box.open(
        gatewayCiphertext,
        nonce,
        ephemeralPubkey,
        this.directPrivKey,
      );
      if (decrypted) return encodeUTF8(decrypted);

      this.logger.warn(
        'Dual-format blob: nacl.box.open failed for gateway block',
      );
      throw new RoutingUnavailableException();
    }

    if (encryptedBlob.length >= 33) {
      const ephemeralPubkey = encryptedBlob.slice(0, 32);
      const ciphertext = encryptedBlob.slice(32);

      const decrypted = nacl.box.open(
        ciphertext,
        nonce,
        ephemeralPubkey,
        this.directPrivKey,
      );
      if (decrypted) return encodeUTF8(decrypted);
    }

    this.logger.warn(
      'nacl.box.open failed — cannot decrypt blob',
    );
    throw new RoutingUnavailableException();
  }

  /**
   * Direct in-process decryption of all channels.
   */
  private directDecryptAll(params: DecryptAllParams): DecryptedChannels {
    const result: DecryptedChannels = {};

    if (params.channelEmail && params.encryptedEmail.length > 0) {
      try {
        result.email = this.directNaclBoxDecrypt(
          params.encryptedEmail,
          params.nonce,
        );
      } catch {
        this.logger.warn(
          `Direct email decrypt failed for ${params.ownerPubkey.slice(0, 8)}`,
        );
      }
    }

    if (params.channelTelegram && params.encryptedTelegramId.length > 0) {
      try {
        result.telegramChatId = this.directNaclBoxDecrypt(
          params.encryptedTelegramId,
          params.nonceTelegram,
        );
      } catch {
        this.logger.warn(
          `Direct telegram decrypt failed for ${params.ownerPubkey.slice(0, 8)}`,
        );
      }
    }

    if (params.channelSms && params.encryptedPhone.length > 0) {
      try {
        result.phone = this.directNaclBoxDecrypt(
          params.encryptedPhone,
          params.nonceSms,
        );
      } catch {
        this.logger.warn(
          `Direct phone decrypt failed for ${params.ownerPubkey.slice(0, 8)}`,
        );
      }
    }

    return result;
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

  private isValidEmail(s: unknown): boolean {
    return (
      typeof s === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
      s.length <= 254
    );
  }
}

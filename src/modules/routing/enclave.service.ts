import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * In development: uses mock decryption with deterministic test values.
 *
 * SEC-003: Plaintext identifiers ONLY exist in memory, never touch filesystem.
 */
@Injectable()
export class EnclaveService {
  private readonly logger = new Logger(EnclaveService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Decrypt an encrypted email (legacy single-channel method).
   */
  async decrypt(params: DecryptParams): Promise<string> {
    const env = this.config.get<string>('NODE_ENV');

    if (env === 'development' || env === 'test') {
      return this.mockDecrypt(params);
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
    if (env === 'development' || env === 'test') {
      return this.mockDecryptAll(params);
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
   * Development mock: decrypt all channels with deterministic test values.
   */
  private async mockDecryptAll(
    params: DecryptAllParams,
  ): Promise<DecryptedChannels> {
    await Promise.resolve();
    const result: DecryptedChannels = {};

    const mappingStr = this.config.get<string>('DEV_DEBUG_EMAILS');
    let mapping: Record<string, any> = {};
    if (mappingStr) {
      try {
        mapping = JSON.parse(mappingStr);
      } catch {
        /* ignore */
      }
    }

    if (params.channelEmail && params.encryptedEmail.length > 0) {
      result.email =
        mapping[params.ownerPubkey] ??
        `test-${params.ownerPubkey.slice(0, 8)}@useherald-dev.xyz`;
    }
    if (params.channelTelegram && params.encryptedTelegramId.length > 0) {
      result.telegramChatId = `mock-chat-${params.ownerPubkey.slice(0, 8)}`;
    }
    if (params.channelSms && params.encryptedPhone.length > 0) {
      result.phone = `+1555000${params.ownerPubkey.slice(0, 4)}`;
    }

    return result;
  }

  /**
   * Development mock: returns a deterministic test email.
   */
  private async mockDecrypt(_params: DecryptParams): Promise<string> {
    await Promise.resolve();

    const mappingStr = this.config.get<string>('DEV_DEBUG_EMAILS');
    if (mappingStr) {
      try {
        const mapping = JSON.parse(mappingStr);
        if (mapping[_params.ownerPubkey]) {
          this.logger.log(
            `Using debug email override for ${_params.ownerPubkey}`,
          );
          return mapping[_params.ownerPubkey];
        }
      } catch (err) {
        this.logger.error('Failed to parse DEV_DEBUG_EMAILS JSON', {
          error: (err as Error).message,
        });
      }
    }

    return `test-${_params.ownerPubkey.slice(0, 8)}@useherald-dev.xyz`;
  }

  private isValidEmail(s: unknown): boolean {
    return (
      typeof s === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
      s.length <= 254
    );
  }
}

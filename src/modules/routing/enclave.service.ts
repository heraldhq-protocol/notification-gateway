import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nacl from 'tweetnacl';
import { RoutingUnavailableException } from '../../common/exceptions/herald.exception.js';

export interface DecryptParams {
  encryptedEmail: Uint8Array;
  nonce: Uint8Array;
  ownerPubkey: string;
}

/**
 * EnclaveService — communicates with AWS Nitro Enclave for email decryption.
 *
 * In production: sends encrypted data to the Nitro Enclave via Unix socket.
 * In development: uses mock NaCl decryption with test keypairs.
 *
 * SEC-003: Plaintext email ONLY exists in memory, never touches filesystem.
 */
@Injectable()
export class EnclaveService {
  private readonly logger = new Logger(EnclaveService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Decrypt an encrypted email.
   * In development mode, uses mock NaCl decryption.
   * In production, delegates to Nitro Enclave via socket.
   */
  async decrypt(params: DecryptParams): Promise<string> {
    const env = this.config.get<string>('NODE_ENV');

    if (env === 'development' || env === 'test') {
      return this.mockDecrypt(params);
    }

    return this.enclaveDecrypt(params);
  }

  /**
   * Production: Nitro Enclave socket communication.
   * Enclave fetches KMS key, decrypts, returns plaintext.
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

      socket.once('data', (data) => {
        clearTimeout(timeout);
        socket.destroy();
        try {
          const response = JSON.parse(data.toString());
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
   * Development mock: returns a deterministic test email.
   * In real dev with local validator, this would use known test keypairs.
   */
  private async mockDecrypt(_params: DecryptParams): Promise<string> {
    // In dev mode, return a mock email for testing
    return `test-${_params.ownerPubkey.slice(0, 8)}@herald-dev.xyz`;
  }

  private isValidEmail(s: unknown): boolean {
    return (
      typeof s === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
      s.length <= 254
    );
  }
}

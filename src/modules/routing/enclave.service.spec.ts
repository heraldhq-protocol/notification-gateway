import * as nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnclaveService } from './enclave.service';

describe('EnclaveService', () => {
  let service: EnclaveService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnclaveService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'HERALD_X25519_PRIV_HEX') {
                // deterministic test key (32 bytes = 64 hex chars)
                return 'deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe';
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<EnclaveService>(EnclaveService);
  });

  describe('encryptForUser', () => {
    it('should return null when no private key is configured', () => {
      const emptyService = new EnclaveService({
        get: jest.fn(() => undefined),
      } as any);
      const result = emptyService.encryptForUser('aa'.repeat(32), {
        subject: 'test',
        message: 'hello',
      });
      expect(result).toBeNull();
    });

    it('should return null for invalid pubkey length', () => {
      const result = service.encryptForUser(
        'aabb', // only 1 byte
        { subject: 'test', message: 'hello' },
      );
      expect(result).toBeNull();
    });

    it('should encrypt a notification body that can be decrypted with the corresponding keypair', () => {
      const userKeypair = nacl.box.keyPair();
      const userPubkeyHex = Buffer.from(userKeypair.publicKey).toString('hex');

      const body = {
        subject: 'Liquidation Warning',
        message: 'Your SOL position is at risk. Health factor: 1.03',
        actionUrl: 'https://app.drift.trade',
      };

      const encrypted = service.encryptForUser(userPubkeyHex, body);
      expect(encrypted).not.toBeNull();

      const ciphertext = Buffer.from(encrypted!.ciphertext, 'hex');
      const nonce = Buffer.from(encrypted!.nonce, 'hex');
      const gatewayPubkey = Buffer.from(encrypted!.gatewayPubkey, 'hex');

      expect(ciphertext.length).toBeGreaterThan(0);
      expect(nonce.length).toBe(24);
      expect(gatewayPubkey.length).toBe(32);

      const decrypted = nacl.box.open(
        ciphertext,
        nonce,
        gatewayPubkey,
        userKeypair.secretKey,
      );

      expect(decrypted).not.toBeNull();
      const parsed = JSON.parse(encodeUTF8(decrypted!));
      expect(parsed.subject).toBe('Liquidation Warning');
      expect(parsed.message).toContain('SOL position');
      expect(parsed.actionUrl).toBe('https://app.drift.trade');
    });

    it('should produce different ciphertexts for the same body (random nonce)', () => {
      const userKeypair = nacl.box.keyPair();
      const userPubkeyHex = Buffer.from(userKeypair.publicKey).toString('hex');

      const body = { subject: 'Test', message: 'Same content' };

      const result1 = service.encryptForUser(userPubkeyHex, body);
      const result2 = service.encryptForUser(userPubkeyHex, body);

      expect(result1!.ciphertext).not.toBe(result2!.ciphertext);
      expect(result1!.nonce).not.toBe(result2!.nonce);
    });

    it('should handle complex notification bodies with metadata', () => {
      const userKeypair = nacl.box.keyPair();
      const userPubkeyHex = Buffer.from(userKeypair.publicKey).toString('hex');

      const body = {
        subject: 'Position Update',
        message: 'Health factor changed',
        metadata: {
          health_factor: '1.03',
          position_value: '$1,512.50',
          protocol: 'MarginFi',
        },
        actionUrl: 'https://app.marginfi.com/positions',
      };

      const encrypted = service.encryptForUser(userPubkeyHex, body);
      expect(encrypted).not.toBeNull();

      const ciphertext = Buffer.from(encrypted!.ciphertext, 'hex');
      const nonce = Buffer.from(encrypted!.nonce, 'hex');
      const gatewayPubkey = Buffer.from(encrypted!.gatewayPubkey, 'hex');

      const decrypted = nacl.box.open(
        ciphertext,
        nonce,
        gatewayPubkey,
        userKeypair.secretKey,
      );
      expect(decrypted).not.toBeNull();

      const parsed = JSON.parse(encodeUTF8(decrypted!));
      expect(parsed.metadata.health_factor).toBe('1.03');
      expect(parsed.metadata.protocol).toBe('MarginFi');
    });
  });
});

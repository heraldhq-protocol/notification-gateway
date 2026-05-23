import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!hex) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WEBHOOK_ENCRYPTION_KEY must be set in production');
    }
    // Dev fallback — 32 zero bytes. Never used for real secrets in dev.
    return Buffer.alloc(32, 0);
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      'WEBHOOK_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)',
    );
  }
  return key;
}

/**
 * Encrypts a webhook signing secret using AES-256-GCM.
 * Output format: `<iv_hex>.<ciphertext_hex>.<auth_tag_hex>`
 */
export function encryptWebhookSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${encrypted.toString('hex')}.${tag.toString('hex')}`;
}

/**
 * Decrypts a webhook signing secret previously encrypted by encryptWebhookSecret.
 */
export function decryptWebhookSecret(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid webhook secret ciphertext format');
  }
  const [ivHex, encHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Returns true if the value looks like an encrypted secret (3-part dot format)
 * rather than a legacy plaintext value. Used during migration.
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts[0].length === 24; // 12-byte IV → 24 hex chars
}

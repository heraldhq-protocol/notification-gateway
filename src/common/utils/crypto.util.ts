import { createHash, randomBytes, createDecipheriv } from 'crypto';

/**
 * AES-256-GCM decryption.
 * Expects input: iv (12 bytes) + authTag (16 bytes) + ciphertext
 */
export function decryptAes256Gcm(
  encrypted: Uint8Array | Buffer,
  keyHex: string,
): string {
  const key = Buffer.from(keyHex, 'hex');
  const buf = Buffer.isBuffer(encrypted)
    ? encrypted
    : Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

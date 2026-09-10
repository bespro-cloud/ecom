import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decodeKeyMaterial } from '@health/config';

/**
 * Envelope encryption for secrets that must be recoverable by the application
 * (currently: TOTP shared secrets).
 *
 * AES-256-GCM. The serialised form carries a version tag so the key can be
 * rotated later without ambiguity about how an existing ciphertext was
 * produced. Passwords are NOT encrypted — they are hashed (see password.ts).
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    const decoded = decodeKeyMaterial(keyMaterial);
    if (decoded === null || decoded.length < 32) {
      throw new EncryptionKeyError('encryption key must decode to at least 32 bytes');
    }
    this.key = decoded.subarray(0, 32);
  }

  /**
   * @param plaintext value to protect
   * @param aad additional authenticated data — pass a stable identifier (e.g.
   *   the owning user id) so a ciphertext cannot be moved between rows.
   */
  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      encrypted.toString('base64'),
      tag.toString('base64'),
    ].join('.');
  }

  decrypt(serialised: string, aad?: string): string {
    const parts = serialised.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new DecryptionError('unrecognised ciphertext envelope');
    }
    const iv = Buffer.from(parts[1] as string, 'base64');
    const payload = Buffer.from(parts[2] as string, 'base64');
    const tag = Buffer.from(parts[3] as string, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new DecryptionError('malformed ciphertext envelope');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
    } catch {
      // Never surface the underlying reason: it distinguishes a wrong key from
      // a tampered payload.
      throw new DecryptionError('unable to decrypt value');
    }
  }
}

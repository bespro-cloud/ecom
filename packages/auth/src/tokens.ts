import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque secret tokens (refresh tokens, password-reset links, invites).
 *
 * The plaintext is shown to the holder exactly once. Only a SHA-256 digest is
 * stored, so a database disclosure does not yield usable credentials. SHA-256
 * (rather than a slow KDF) is correct here because these are 256-bit random
 * values with no guessable structure.
 */

export const OPAQUE_TOKEN_BYTES = 32;

export function generateOpaqueToken(bytes = OPAQUE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function tokenHashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Recovery codes are displayed grouped for legibility but compared after
 * normalisation, so users may type them with or without the dash and in any
 * case.
 */
export function generateRecoveryCode(): string {
  // Crockford-style alphabet: no I, L, O, U — avoids transcription errors.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const raw = randomBytes(10);
  let out = '';
  for (const byte of raw) {
    out += alphabet[byte % alphabet.length];
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return hashToken(normaliseRecoveryCode(code));
}

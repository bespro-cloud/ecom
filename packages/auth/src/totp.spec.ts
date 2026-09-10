import { describe, expect, it } from 'vitest';
import { generateTotpCode, generateTotpSecret, TOTP_PERIOD_SECONDS, verifyTotp } from './totp.js';

const AT = new Date('2026-03-01T12:00:00.000Z');

describe('generateTotpSecret', () => {
  it('produces a base32 secret and an otpauth URI', () => {
    const { secret, uri } = generateTotpSecret('Health Commerce', 'alice@example.com');
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Health%20Commerce');
  });
});

describe('verifyTotp', () => {
  it('accepts the current code', () => {
    const { secret } = generateTotpSecret('Health Commerce', 'alice@example.com');
    const code = generateTotpCode(secret, AT);
    expect(verifyTotp(secret, code, { at: AT }).valid).toBe(true);
  });

  it('accepts a code one step old (clock drift)', () => {
    const { secret } = generateTotpSecret('Health Commerce', 'alice@example.com');
    const code = generateTotpCode(secret, new Date(AT.getTime() - TOTP_PERIOD_SECONDS * 1000));
    expect(verifyTotp(secret, code, { at: AT }).valid).toBe(true);
  });

  it('rejects a code two steps old', () => {
    const { secret } = generateTotpSecret('Health Commerce', 'alice@example.com');
    const code = generateTotpCode(secret, new Date(AT.getTime() - TOTP_PERIOD_SECONDS * 3000));
    expect(verifyTotp(secret, code, { at: AT }).valid).toBe(false);
  });

  it('rejects replay of an already-spent counter', () => {
    const { secret } = generateTotpSecret('Health Commerce', 'alice@example.com');
    const code = generateTotpCode(secret, AT);
    const first = verifyTotp(secret, code, { at: AT });
    expect(first.valid).toBe(true);
    expect(first.counter).not.toBeNull();

    const replay = verifyTotp(secret, code, { at: AT, lastUsedCounter: first.counter });
    expect(replay.valid).toBe(false);
  });

  it('rejects malformed codes without consulting the secret', () => {
    const { secret } = generateTotpSecret('Health Commerce', 'alice@example.com');
    expect(verifyTotp(secret, 'abcdef', { at: AT }).valid).toBe(false);
    expect(verifyTotp(secret, '12345', { at: AT }).valid).toBe(false);
    expect(verifyTotp(secret, '', { at: AT }).valid).toBe(false);
  });

  it('tolerates user-entered whitespace', () => {
    const { secret } = generateTotpSecret('Health Commerce', 'alice@example.com');
    const code = generateTotpCode(secret, AT);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { at: AT }).valid).toBe(true);
  });

  it('rejects rather than throws on an invalid secret', () => {
    expect(verifyTotp('!!!not-base32!!!', '123456', { at: AT }).valid).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  generateOpaqueToken,
  generateRecoveryCode,
  hashRecoveryCode,
  hashToken,
  normaliseRecoveryCode,
  tokenHashesEqual,
} from './tokens.js';

describe('generateOpaqueToken', () => {
  it('produces url-safe 256-bit tokens', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('hashToken', () => {
  it('is deterministic and hides the input', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });
});

describe('tokenHashesEqual', () => {
  it('matches equal digests and rejects others', () => {
    const digest = hashToken('a');
    expect(tokenHashesEqual(digest, digest)).toBe(true);
    expect(tokenHashesEqual(digest, hashToken('b'))).toBe(false);
    expect(tokenHashesEqual(digest, 'short')).toBe(false);
  });
});

describe('recovery codes', () => {
  it('uses an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateRecoveryCode()).toMatch(
        /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/,
      );
    }
  });

  it('normalises formatting and case before hashing', () => {
    const code = generateRecoveryCode();
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(code.replace('-', ''));
    expect(hashRecoveryCode(code.toLowerCase().replace('-', ' '))).toBe(hashRecoveryCode(code));
  });
});

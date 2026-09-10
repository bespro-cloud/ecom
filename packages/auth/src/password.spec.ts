import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_HASH_PREFIX,
  burnPasswordComparison,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

describe('hashPassword', () => {
  it('produces an argon2id hash that verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('salts, so identical passwords hash differently', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('rejects passwords below the minimum length', async () => {
    await expect(hashPassword('short')).rejects.toThrow(RangeError);
  });

  it('rejects absurdly long passwords rather than hashing them', async () => {
    await expect(hashPassword('a'.repeat(1000))).rejects.toThrow(RangeError);
  });
});

describe('verifyPassword', () => {
  it('returns false for a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'incorrect horse battery')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a corrupted hash', async () => {
    await expect(verifyPassword('not-a-hash', 'correct horse battery staple')).resolves.toBe(false);
  });

  it('returns false for empty input', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything at all')).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('flags hashes weaker than current policy', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
  });

  it('accepts hashes at current policy', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(needsRehash(hash)).toBe(false);
  });

  it('flags unrecognised formats', () => {
    expect(needsRehash('$2b$12$something')).toBe(true);
  });
});

describe('burnPasswordComparison', () => {
  it('never throws, whatever it is handed', async () => {
    await expect(burnPasswordComparison('anything')).resolves.toBeUndefined();
    await expect(burnPasswordComparison('')).resolves.toBeUndefined();
  });
});

describe('ARGON2_OPTIONS', () => {
  it('selects argon2id (guards the const-enum workaround)', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith(ARGON2ID_HASH_PREFIX)).toBe(true);
    expect(hash).toContain('m=19456,t=2,p=1');
  });
});

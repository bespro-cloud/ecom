import { describe, expect, it } from 'vitest';
import { DecryptionError, EncryptionKeyError, SecretBox } from './encryption.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('SecretBox', () => {
  it('round-trips a value', () => {
    const box = new SecretBox(KEY);
    const ciphertext = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(ciphertext).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.decrypt(ciphertext)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV per call', () => {
    const box = new SecretBox(KEY);
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a ciphertext produced under a different key', () => {
    const ciphertext = new SecretBox(KEY).encrypt('secret value');
    expect(() => new SecretBox(OTHER_KEY).decrypt(ciphertext)).toThrow(DecryptionError);
  });

  it('binds ciphertext to its AAD so it cannot be moved between rows', () => {
    const box = new SecretBox(KEY);
    const ciphertext = box.encrypt('secret value', 'user-a');
    expect(box.decrypt(ciphertext, 'user-a')).toBe('secret value');
    expect(() => box.decrypt(ciphertext, 'user-b')).toThrow(DecryptionError);
  });

  it('detects tampering with the payload', () => {
    const box = new SecretBox(KEY);
    const parts = box.encrypt('secret value').split('.');
    const tampered = Buffer.from(parts[2]!, 'base64');
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    parts[2] = tampered.toString('base64');
    expect(() => box.decrypt(parts.join('.'))).toThrow(DecryptionError);
  });

  it('rejects malformed envelopes', () => {
    const box = new SecretBox(KEY);
    expect(() => box.decrypt('garbage')).toThrow(DecryptionError);
    expect(() => box.decrypt('v2.a.b.c')).toThrow(DecryptionError);
  });

  it('refuses to construct with weak key material', () => {
    expect(() => new SecretBox(Buffer.alloc(8).toString('base64'))).toThrow(EncryptionKeyError);
  });
});

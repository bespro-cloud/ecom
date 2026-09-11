import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemStorageProvider } from './filesystem-provider.js';
import { ObjectNotFoundError } from './types.js';
import { checksumOf, contentAddressedKey } from './keys.js';

let root: string;
let provider: FilesystemStorageProvider;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hc-storage-'));
  provider = new FilesystemStorageProvider({
    root,
    baseUrl: 'http://localhost:4000/api/v1/media/files',
    signingKey: 'a-development-signing-key-of-sufficient-length',
  });
  await provider.verifyConfiguration();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FilesystemStorageProvider', () => {
  it('round-trips an object', async () => {
    const body = Buffer.from('local development image');
    const key = contentAddressedKey('products', checksumOf(body), 'png');

    const stored = await provider.put({ key, body, mimeType: 'image/png' });
    expect(stored.checksum).toBe(checksumOf(body));
    expect((await provider.get(key)).equals(body)).toBe(true);
    expect(await provider.exists(key)).toBe(true);
  });

  it('raises a typed error for a missing object', async () => {
    await expect(provider.get('products/zz/zz/missing.png')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it('deletes idempotently', async () => {
    const body = Buffer.from('delete me');
    const key = contentAddressedKey('products', checksumOf(body), 'png');
    await provider.put({ key, body, mimeType: 'image/png' });

    await provider.delete(key);
    await expect(provider.delete(key)).resolves.toBeUndefined();
    expect(await provider.exists(key)).toBe(false);
  });

  it('refuses a key that would escape the storage root', async () => {
    // The key is derived from a checksum upstream, but a filesystem write is
    // not somewhere to rely on an upstream invariant.
    const outside = join(root, '..', 'escaped.txt');
    await expect(
      provider.put({ key: '../escaped.txt', body: Buffer.from('x'), mimeType: 'text/plain' }),
    ).rejects.toThrow(/outside the storage root/);
    await expect(
      provider.put({
        key: '../../../etc/passwd',
        body: Buffer.from('x'),
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow(/outside the storage root/);
    await expect(provider.get('../escaped.txt')).rejects.toThrow(/outside the storage root/);
    await rm(outside, { force: true });
  });

  it('refuses a key containing a null byte', async () => {
    await expect(
      provider.put({ key: 'products/a\0b.png', body: Buffer.from('x'), mimeType: 'image/png' }),
    ).rejects.toThrow(/null byte/);
  });

  it('signs a readable URL and verifies its own signature', async () => {
    const body = Buffer.from('signed');
    const key = contentAddressedKey('documents', checksumOf(body), 'pdf');
    await provider.put({ key, body, mimeType: 'application/pdf' });

    const url = new URL(await provider.signedReadUrl(key, 300));
    const expires = url.searchParams.get('expires')!;
    const signature = url.searchParams.get('signature')!;

    expect(provider.verifySignature(key, expires, signature)).toBe(true);
  });

  it('rejects a tampered signature, a wrong key and an expired window', async () => {
    const key = 'documents/aa/bb/doc.pdf';
    const url = new URL(await provider.signedReadUrl(key, 300));
    const expires = url.searchParams.get('expires')!;
    const signature = url.searchParams.get('signature')!;

    expect(provider.verifySignature(key, expires, `${signature.slice(0, -1)}0`)).toBe(false);
    expect(provider.verifySignature('documents/aa/bb/other.pdf', expires, signature)).toBe(false);
    expect(provider.verifySignature(key, '1', signature)).toBe(false);
    expect(provider.verifySignature(key, 'not-a-number', signature)).toBe(false);
  });

  it('does not accept a signature made with a different key', async () => {
    const other = new FilesystemStorageProvider({
      root,
      baseUrl: 'http://localhost:4000/api/v1/media/files',
      signingKey: 'a-completely-different-development-signing-key',
    });
    const key = 'documents/aa/bb/doc.pdf';
    const url = new URL(await other.signedReadUrl(key, 300));

    expect(
      provider.verifySignature(
        key,
        url.searchParams.get('expires')!,
        url.searchParams.get('signature')!,
      ),
    ).toBe(false);
  });

  it('reports an unwritable root rather than failing at the first upload', async () => {
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'x');
    const broken = new FilesystemStorageProvider({
      root: join(file, 'nested'),
      baseUrl: 'http://localhost:4000/files',
    });
    await expect(broken.verifyConfiguration()).rejects.toThrow();
  });
});

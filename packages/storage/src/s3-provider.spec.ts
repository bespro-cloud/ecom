import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import S3rver from 's3rver';
import { S3StorageProvider } from './s3-provider.js';
import { ObjectNotFoundError } from './types.js';
import { checksumOf, contentAddressedKey } from './keys.js';

/**
 * The S3 adapter, exercised against a real S3 protocol server.
 *
 * This is the same class that runs in production — pointed at a local
 * implementation of the protocol rather than at AWS. Mocking the SDK would test
 * that we can call our own mock; this tests that we speak S3.
 */

const BUCKET = 'test-media';
let server: S3rver;
let provider: S3StorageProvider;
let directory: string;
let endpoint: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 's3rver-'));
  server = new S3rver({
    port: 0, // let the OS choose, so a parallel run cannot collide
    address: '127.0.0.1',
    silent: true,
    directory,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  const address = (await server.run()) as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}`;

  provider = new S3StorageProvider({
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint,
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    forcePathStyle: true,
  });
});

afterAll(async () => {
  provider?.destroy();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

describe('S3StorageProvider', () => {
  it('confirms the bucket is reachable', async () => {
    await expect(provider.verifyConfiguration()).resolves.toBeUndefined();
  });

  it('fails configuration checks against a bucket that does not exist', async () => {
    const wrong = new S3StorageProvider({
      bucket: 'no-such-bucket',
      region: 'us-east-1',
      endpoint,
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      forcePathStyle: true,
    });
    await expect(wrong.verifyConfiguration()).rejects.toThrow(/not reachable/);
    wrong.destroy();
  });

  it('round-trips an object with its content type', async () => {
    const body = Buffer.from('a small png, notionally');
    const key = contentAddressedKey('products', checksumOf(body), 'png');

    const stored = await provider.put({ key, body, mimeType: 'image/png' });

    expect(stored.key).toBe(key);
    expect(stored.bucket).toBe(BUCKET);
    expect(stored.sizeBytes).toBe(body.byteLength);
    expect(stored.checksum).toBe(checksumOf(body));

    const fetched = await provider.get(key);
    expect(fetched.equals(body)).toBe(true);
  });

  it('reports existence accurately', async () => {
    const body = Buffer.from('exists');
    const key = contentAddressedKey('products', checksumOf(body), 'jpg');

    expect(await provider.exists(key)).toBe(false);
    await provider.put({ key, body, mimeType: 'image/jpeg' });
    expect(await provider.exists(key)).toBe(true);
  });

  it('raises a typed error for a missing object rather than a generic failure', async () => {
    await expect(provider.get('products/aa/bb/does-not-exist.jpg')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it('treats deleting a missing object as success', async () => {
    // S3 delete is idempotent, and a retry after a timeout must not fail.
    await expect(provider.delete('products/aa/bb/never-existed.jpg')).resolves.toBeUndefined();
  });

  it('deletes an object', async () => {
    const body = Buffer.from('to be removed');
    const key = contentAddressedKey('products', checksumOf(body), 'png');
    await provider.put({ key, body, mimeType: 'image/png' });

    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
  });

  it('writing the same content twice is idempotent', async () => {
    const body = Buffer.from('identical content');
    const key = contentAddressedKey('products', checksumOf(body), 'png');

    const first = await provider.put({ key, body, mimeType: 'image/png' });
    const second = await provider.put({ key, body, mimeType: 'image/png' });

    expect(first.key).toBe(second.key);
    expect(first.checksum).toBe(second.checksum);
    expect((await provider.get(key)).equals(body)).toBe(true);
  });

  it('produces a presigned URL that actually fetches the object', async () => {
    const body = Buffer.from('private compliance document');
    const key = contentAddressedKey('documents', checksumOf(body), 'pdf');
    await provider.put({ key, body, mimeType: 'application/pdf' });

    const url = await provider.signedReadUrl(key, 120);
    expect(url).toContain('X-Amz-Signature');
    expect(url).toContain('X-Amz-Expires=120');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
  });

  it('refuses a presign window outside what S3 accepts', async () => {
    await expect(provider.signedReadUrl('some/key', 0)).rejects.toThrow(RangeError);
    await expect(provider.signedReadUrl('some/key', 8 * 24 * 60 * 60)).rejects.toThrow(RangeError);
  });

  it('builds a path-style public URL when configured for it', () => {
    expect(provider.publicUrl('products/aa/bb/x.jpg')).toBe(
      `${endpoint}/${BUCKET}/products/aa/bb/x.jpg`,
    );
  });

  it('prefers the CDN origin when one is configured', () => {
    const cdn = new S3StorageProvider({
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      publicBaseUrl: 'https://cdn.example.test/',
    });
    expect(cdn.publicUrl('products/aa/bb/x.jpg')).toBe(
      'https://cdn.example.test/products/aa/bb/x.jpg',
    );
    cdn.destroy();
  });

  it('builds an AWS virtual-hosted URL with no endpoint override', () => {
    const aws = new S3StorageProvider({ bucket: 'prod-media', region: 'us-west-2' });
    expect(aws.publicUrl('products/aa/bb/x.jpg')).toBe(
      'https://prod-media.s3.us-west-2.amazonaws.com/products/aa/bb/x.jpg',
    );
    aws.destroy();
  });
});
